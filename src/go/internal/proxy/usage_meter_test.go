package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/outof0/anypick/go/internal/usagelog"
)

func captureUsage(t *testing.T) *[]usagelog.Event {
	t.Helper()
	var got []usagelog.Event
	SetUsageRecorder(func(e usagelog.Event) { got = append(got, e) })
	t.Cleanup(func() { SetUsageRecorder(nil) })
	return &got
}

// meter writes one response through MeterUsage in chunks, the way a stream
// arrives, and returns what was recorded.
func meter(t *testing.T, status int, contentType string, chunks ...string) []usagelog.Event {
	t.Helper()
	got := captureUsage(t)
	rec := httptest.NewRecorder()
	w, finish := MeterUsage(rec, "proxy.single", "claude", "work", "requested-model")
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	for _, c := range chunks {
		_, _ = w.Write([]byte(c))
	}
	finish()
	if body := rec.Body.String(); body != strings.Join(chunks, "") {
		t.Fatalf("the meter changed the response: %q", body)
	}
	return *got
}

func TestMeterReadsEveryWireShape(t *testing.T) {
	cases := []struct {
		name        string
		contentType string
		chunks      []string
		want        usagelog.Event
	}{
		{
			name:        "openai chat json, cached prompt split out",
			contentType: "application/json",
			chunks: []string{`{"model":"gpt-x","choices":[],"usage":{"prompt_tokens":100,`,
				`"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30}}}`},
			want: usagelog.Event{Model: "gpt-x", InputTokens: 70, OutputTokens: 20, CacheReadTokens: 30, Reported: true},
		},
		{
			name:        "anthropic stream, input on start and cumulative output on delta",
			contentType: "text/event-stream",
			chunks: []string{
				"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":400,\"cache_creation_input_tokens\":50,\"output_tokens\":1}}}\n\n",
				"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n",
				"event: message_delta\ndata: {\"type\":\"message_delta\",\"usa", "ge\":{\"output_tokens\":77}}\n\n",
			},
			want: usagelog.Event{Model: "claude-opus-5-5", InputTokens: 12, OutputTokens: 77, CacheReadTokens: 400, CacheWriteTokens: 50, Reported: true},
		},
		{
			name:        "openai responses stream completed event",
			contentType: "text/event-stream; charset=utf-8",
			chunks:      []string{"data: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-y\",\"usage\":{\"input_tokens\":50,\"input_tokens_details\":{\"cached_tokens\":10},\"output_tokens\":5}}}\n"},
			want:        usagelog.Event{Model: "gpt-y", InputTokens: 40, OutputTokens: 5, CacheReadTokens: 10, Reported: true},
		},
		{
			name:        "gemini json counts thoughts as output",
			contentType: "application/json",
			chunks:      []string{`{"modelVersion":"gemini-z","usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3,"thoughtsTokenCount":4}}`},
			want:        usagelog.Event{Model: "gemini-z", InputTokens: 9, OutputTokens: 7, Reported: true},
		},
		{
			name:        "openai stream without include_usage falls back to the request model",
			contentType: "text/event-stream",
			chunks:      []string{"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\ndata: [DONE]\n\n"},
			want:        usagelog.Event{Model: "requested-model"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := meter(t, http.StatusOK, tc.contentType, tc.chunks...)
			if len(got) != 1 {
				t.Fatalf("recorded %d events, want 1", len(got))
			}
			e := got[0]
			tc.want.At, tc.want.Route, tc.want.Provider, tc.want.Account, tc.want.Status = e.At, "proxy.single", "claude", "work", 200
			if e != tc.want {
				t.Fatalf("event = %+v\nwant    %+v", e, tc.want)
			}
		})
	}
}

// A refusal is not usage: the ring or hub that held it back may still serve
// the request elsewhere, and that serve is the one that counts.
func TestMeterRecordsOnlySuccessfulResponses(t *testing.T) {
	if got := meter(t, http.StatusTooManyRequests, "application/json",
		`{"error":{"message":"quota"},"usage":{"prompt_tokens":5,"completion_tokens":0}}`); len(got) != 0 {
		t.Fatalf("a 429 was recorded: %+v", got)
	}
}

func TestMeterIsTransparentWhenNothingRecords(t *testing.T) {
	SetUsageRecorder(nil)
	rec := httptest.NewRecorder()
	w, finish := MeterUsage(rec, "proxy.single", "claude", "work", "")
	if w != http.ResponseWriter(rec) {
		t.Fatal("MeterUsage wrapped the writer with no recorder set")
	}
	finish()
}

// The model column holds a vendor-supplied string for 90 days; anything that
// does not look like a model id is dropped rather than stored.
func TestMeterDropsAModelThatIsNotAnID(t *testing.T) {
	got := meter(t, http.StatusOK, "application/json",
		`{"model":"<script>alert(1)</script>","usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	if len(got) != 1 || got[0].Model != "" {
		t.Fatalf("event = %+v", got)
	}
}

// Requests read the recorder while a child installs or clears it on start and
// shutdown. Under -race this fails if the recorder is a plain variable.
func TestMeterToleratesTheRecorderChangingUnderLoad(t *testing.T) {
	t.Cleanup(func() { SetUsageRecorder(nil) })
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				w, finish := MeterUsage(httptest.NewRecorder(), "proxy.single", "p", "a", "")
				_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
				finish()
			}
		}()
	}
	for j := 0; j < 200; j++ {
		SetUsageRecorder(func(usagelog.Event) {})
		SetUsageRecorder(nil)
	}
	wg.Wait()
}
