package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/outof0/anypick/go/internal/usagelog"
)

// usageRecorder receives one event per successful response a serving leaf
// commits (ADR-0037). It is unset by default, which records nothing; the
// detached proxy, pool and hub children set it through SetUsageRecorder. It is
// read by every in-flight request and cleared on shutdown, hence atomic.
var usageRecorder atomic.Pointer[func(usagelog.Event)]

// SetUsageRecorder installs record, or clears the recorder when record is nil.
// record must not block: it runs on the request path after the response.
func SetUsageRecorder(record func(usagelog.Event)) {
	if record == nil {
		usageRecorder.Store(nil)
		return
	}
	usageRecorder.Store(&record)
}

func loadUsageRecorder() func(usagelog.Event) {
	if p := usageRecorder.Load(); p != nil {
		return *p
	}
	return nil
}

// Bounds on what the meter holds while it reads a response. A body or SSE line
// larger than these is passed through untouched and recorded without tokens.
const (
	maxMeteredJSON = 4 << 20
	maxMeteredLine = 1 << 20
)

// MeterUsage wraps w so the token usage of the response written through it is
// recorded under provider/account when finish is called. It reads only the
// bytes already going to the client — the usage object and the model id — so
// translated and passthrough responses are metered by the same code, in the
// protocol the client speaks.
//
// finish records nothing unless a 2xx response was written: history counts
// served responses, and a refusal held back for failover never reaches the
// wrapped writer. requestModel is used when the response names no model.
func MeterUsage(w http.ResponseWriter, route, provider, account, requestModel string) (http.ResponseWriter, func()) {
	record := loadUsageRecorder()
	if record == nil {
		return w, func() {}
	}
	m := &usageMeter{ResponseWriter: w}
	return m, func() {
		if !m.wrote || m.status < 200 || m.status > 299 {
			return
		}
		if !m.sse && !m.overflow {
			m.absorbJSON(m.body.Bytes())
		}
		model := m.tally.model
		if model == "" {
			model = requestModel
		}
		record(usagelog.Event{
			At: time.Now().UnixMilli(), Route: route, Provider: provider, Account: account,
			Model: usagelog.CleanModel(model), Status: m.status,
			InputTokens: m.tally.input, OutputTokens: m.tally.output,
			CacheReadTokens: m.tally.cacheRead, CacheWriteTokens: m.tally.cacheWrite,
			Reported: m.tally.reported,
		})
	}
}

// requestModelOf reads the model a buffered request names, as the fallback for
// a response that names none. It costs a parse, so it is skipped when nothing
// records usage.
func requestModelOf(body []byte) string {
	if loadUsageRecorder() == nil || len(body) == 0 {
		return ""
	}
	var probe struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(body, &probe)
	return probe.Model
}

type usageMeter struct {
	http.ResponseWriter
	status   int
	wrote    bool
	sse      bool
	overflow bool
	body     bytes.Buffer
	line     []byte
	skipLine bool
	tally    usageTally
}

func (m *usageMeter) WriteHeader(status int) {
	if !m.wrote {
		m.wrote = true
		m.status = status
		m.sse = strings.Contains(strings.ToLower(m.Header().Get("Content-Type")), "event-stream")
	}
	m.ResponseWriter.WriteHeader(status)
}

func (m *usageMeter) Write(p []byte) (int, error) {
	if !m.wrote {
		m.WriteHeader(http.StatusOK)
	}
	n, err := m.ResponseWriter.Write(p)
	if m.status >= 200 && m.status <= 299 {
		if m.sse {
			m.scanSSE(p[:n])
		} else if !m.overflow {
			if m.body.Len()+n > maxMeteredJSON {
				m.overflow = true
				m.body = bytes.Buffer{}
			} else {
				m.body.Write(p[:n])
			}
		}
	}
	return n, err
}

// Flush keeps streaming working through the meter; see StatusRecorder.Flush.
func (m *usageMeter) Flush() {
	if f, ok := m.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (m *usageMeter) Unwrap() http.ResponseWriter { return m.ResponseWriter }

// scanSSE parses only the data lines that can carry usage or, until it is
// known, the model id. Content deltas are skipped without decoding.
func (m *usageMeter) scanSSE(p []byte) {
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			m.appendLine(p)
			return
		}
		m.appendLine(p[:i])
		if !m.skipLine {
			m.absorbSSELine(m.line)
		}
		m.line = m.line[:0]
		m.skipLine = false
		p = p[i+1:]
	}
}

func (m *usageMeter) appendLine(p []byte) {
	if m.skipLine {
		return
	}
	if len(m.line)+len(p) > maxMeteredLine {
		m.skipLine = true
		m.line = m.line[:0]
		return
	}
	m.line = append(m.line, p...)
}

func (m *usageMeter) absorbSSELine(line []byte) {
	line = bytes.TrimSpace(line)
	if !bytes.HasPrefix(line, []byte("data:")) {
		return
	}
	data := bytes.TrimSpace(line[len("data:"):])
	// `"usage` also matches Gemini's "usageMetadata".
	if !bytes.Contains(data, []byte(`"usage`)) && (m.tally.model != "" || !bytes.Contains(data, []byte(`"model`))) {
		return
	}
	m.absorbJSON(data)
}

func (m *usageMeter) absorbJSON(raw []byte) {
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return
	}
	m.tally.absorb(obj)
}

// usageTally merges usage across a response's events. Fields take their
// maximum: Anthropic reports input on message_start and a cumulative output on
// message_delta, and every other shape reports once.
type usageTally struct {
	input, output, cacheRead, cacheWrite int64
	reported                             bool
	model                                string
}

func (t *usageTally) absorb(obj map[string]any) {
	if t.model == "" {
		for _, key := range []string{"model", "modelVersion"} {
			if s, ok := obj[key].(string); ok && s != "" {
				t.model = s
				break
			}
		}
	}
	if u, ok := obj["usage"].(map[string]any); ok {
		t.absorbUsage(u)
	}
	if u, ok := obj["usageMetadata"].(map[string]any); ok {
		t.absorbGemini(u)
	}
	// Anthropic message_start nests the message; Responses events nest the
	// response.
	for _, key := range []string{"message", "response"} {
		if nested, ok := obj[key].(map[string]any); ok {
			t.absorb(nested)
		}
	}
}

func (t *usageTally) absorbUsage(u map[string]any) {
	switch {
	case has(u, "prompt_tokens"):
		// OpenAI chat: prompt_tokens includes the cached part.
		cached := count(nested(u, "prompt_tokens_details"), "cached_tokens")
		t.merge(count(u, "prompt_tokens")-cached, count(u, "completion_tokens"), cached, 0)
	case nested(u, "input_tokens_details") != nil:
		// OpenAI Responses: input_tokens includes the cached part.
		cached := count(nested(u, "input_tokens_details"), "cached_tokens")
		t.merge(count(u, "input_tokens")-cached, count(u, "output_tokens"), cached, 0)
	case has(u, "input_tokens"), has(u, "output_tokens"):
		// Anthropic: input_tokens already excludes cache reads and writes.
		t.merge(count(u, "input_tokens"), count(u, "output_tokens"),
			count(u, "cache_read_input_tokens"), count(u, "cache_creation_input_tokens"))
	}
}

func (t *usageTally) absorbGemini(u map[string]any) {
	if !has(u, "promptTokenCount") && !has(u, "candidatesTokenCount") {
		return
	}
	cached := count(u, "cachedContentTokenCount")
	t.merge(count(u, "promptTokenCount")-cached,
		count(u, "candidatesTokenCount")+count(u, "thoughtsTokenCount"), cached, 0)
}

func (t *usageTally) merge(input, output, cacheRead, cacheWrite int64) {
	t.reported = true
	t.input = max(t.input, max(input, 0))
	t.output = max(t.output, max(output, 0))
	t.cacheRead = max(t.cacheRead, max(cacheRead, 0))
	t.cacheWrite = max(t.cacheWrite, max(cacheWrite, 0))
}

func has(m map[string]any, key string) bool {
	_, ok := m[key].(float64)
	return ok
}

func count(m map[string]any, key string) int64 {
	if m == nil {
		return 0
	}
	f, _ := m[key].(float64)
	return int64(f)
}

func nested(m map[string]any, key string) map[string]any {
	n, _ := m[key].(map[string]any)
	return n
}
