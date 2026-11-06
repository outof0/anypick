package proxy

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/outof0/anypick/go/internal/protocol"
)

var translatedMessageStreamTraceID atomic.Uint64

// traceTranslatedMessagesStream logs enough lifecycle metadata to distinguish
// a normal SSE finish from an upstream EOF or a disconnected client. Payloads
// and credentials never enter the trace.
func traceTranslatedMessagesStream(resp *http.Response, w http.ResponseWriter) {
	id := translatedMessageStreamTraceID.Add(1)
	started := time.Now()
	proxyLogf("messages stream trace=%d start status=%d", id, resp.StatusCode)

	trace, err := protocol.TranslateStreamingResponseWithTrace(resp, w)
	firstDataMS := int64(-1)
	if trace.FirstDataSeen {
		firstDataMS = trace.FirstDataAfterMS
	}
	proxyLogf(
		"messages stream trace=%d end=%s done=%t finish_reason=%s sse_error=%t malformed_frames=%d data_frames=%d upstream_bytes=%d first_data_ms=%d client_write_error=%t read_error=%s elapsed_ms=%d",
		id, trace.ReadEnd, trace.DoneMarker, trace.FinishReason, trace.ErrorEvent,
		trace.MalformedFrames, trace.DataFrames, trace.UpstreamBytes, firstDataMS,
		trace.ClientWriteError, messageStreamErrorKind(err), time.Since(started).Milliseconds(),
	)
}

func messageStreamErrorKind(err error) string {
	if err == nil {
		return "none"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return "timeout"
	}
	return "other"
}
