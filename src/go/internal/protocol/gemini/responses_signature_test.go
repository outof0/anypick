package gemini

import (
	"encoding/json"
	"strings"
	"testing"
)

// The reasoning item that carries a tool call's thought signature has no
// summary text. Codex drops a reasoning item without a summary field, so the
// signature never came back and Gemini rejected the next tool turn.
func TestToolSignatureReasoningItemAlwaysHasSummary(t *testing.T) {
	res := &GeminiGenerateResponse{Candidates: []GeminiCandidate{{Content: &GeminiContent{Role: "model", Parts: []GeminiPart{
		{Text: "I will check the date."},
		{FunctionCall: &GeminiFunctionCall{Name: "exec_command", Args: map[string]interface{}{"cmd": "date"}}, ThoughtSignature: "sig-1"},
	}}}}}
	out := GeminiToOpenAIResponses(res, "gemini-3.8-flash-tiered")
	var carrier *OpenAIResponseOutputItem
	for i := range out.Output {
		if out.Output[i].Type == "reasoning" && out.Output[i].EncryptedContent == "sig-1" {
			carrier = &out.Output[i]
		}
	}
	if carrier == nil {
		t.Fatalf("no reasoning item carries the signature: %+v", out.Output)
	}
	raw, err := json.Marshal(carrier)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(raw), `"summary":`) != 1 || !strings.Contains(string(raw), `"summary":[]`) ||
		!strings.Contains(string(raw), `"encrypted_content":"sig-1"`) {
		t.Fatalf("reasoning item = %s", raw)
	}
	// Other item types keep their compact shape.
	msg, _ := json.Marshal(OpenAIResponseOutputItem{ID: "m", Type: "message"})
	if strings.Contains(string(msg), "summary") {
		t.Fatalf("message item gained summary: %s", msg)
	}
}

// Characterizes the input side: the signature Codex echoes back on that
// reasoning item reaches the functionCall part of the next Gemini request.
func TestToolSignatureRoundTripsToTheFunctionCallPart(t *testing.T) {
	input := `[
	 {"type":"message","role":"user","content":[{"type":"input_text","text":"date?"}]},
	 {"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will check the date."}]},
	 {"type":"reasoning","summary":[],"encrypted_content":"sig-1"},
	 {"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\"cmd\":\"date\"}"},
	 {"type":"function_call_output","call_id":"call_1","output":"Thu"}]`
	req := OpenAIResponsesToGemini(OpenAIResponsesRequest{Model: "gemini-3.8-flash-tiered", Input: json.RawMessage(input)}, "gemini-3.8-flash-tiered")
	for _, content := range req.Contents {
		for _, part := range content.Parts {
			if part.FunctionCall != nil {
				if part.ThoughtSignature != "sig-1" {
					t.Fatalf("functionCall signature = %q", part.ThoughtSignature)
				}
				return
			}
		}
	}
	t.Fatal("no functionCall part in the Gemini request")
}
