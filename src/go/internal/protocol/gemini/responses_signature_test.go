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

// History that lost its signature (a thread written before 1.2.1) gets the
// documented placeholder on the first functionCall of each model step, so the
// conversation can continue; a real signature is never replaced.
func TestFillMissingToolSignaturesOnlyFillsTheFirstCallOfAStep(t *testing.T) {
	req := &GeminiGenerateRequest{Contents: []GeminiContent{
		{Role: "user", Parts: []GeminiPart{{Text: "go"}}},
		{Role: "model", Parts: []GeminiPart{
			{Text: "running"},
			{FunctionCall: &GeminiFunctionCall{Name: "a"}},
			{FunctionCall: &GeminiFunctionCall{Name: "b"}},
		}},
		{Role: "user", Parts: []GeminiPart{{FunctionResponse: &GeminiFunctionResponse{Name: "a"}}}},
		{Role: "model", Parts: []GeminiPart{{FunctionCall: &GeminiFunctionCall{Name: "c"}, ThoughtSignature: "real"}}},
	}}
	if n := FillMissingToolSignatures(req, "gemini-3.8-flash-tiered"); n != 1 {
		t.Fatalf("filled %d, want 1", n)
	}
	step := req.Contents[1].Parts
	if step[1].ThoughtSignature != SkipThoughtSignature || step[2].ThoughtSignature != "" || step[0].ThoughtSignature != "" {
		t.Fatalf("first step = %+v", step)
	}
	if got := req.Contents[3].Parts[0].ThoughtSignature; got != "real" {
		t.Fatalf("real signature replaced with %q", got)
	}
}

// End to end on the Responses path the proxy serves Codex: a pre-1.2.1 thread
// with no signature item before its function_call reaches Gemini signed.
func TestResponsesHistoryWithoutSignatureIsFilled(t *testing.T) {
	input := `[
	 {"type":"message","role":"user","content":[{"type":"input_text","text":"date?"}]},
	 {"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]},
	 {"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will check."}]},
	 {"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{}"},
	 {"type":"function_call_output","call_id":"call_1","output":"Thu"},
	 {"type":"message","role":"user","content":[{"type":"input_text","text":"again"}]}]`
	req := OpenAIResponsesToGemini(OpenAIResponsesRequest{Input: json.RawMessage(input)}, "gemini-3.8-flash-tiered")
	FillMissingToolSignatures(req, "gemini-3.8-flash-tiered")
	for _, content := range req.Contents {
		for _, part := range content.Parts {
			if part.FunctionCall != nil && part.ThoughtSignature == "" {
				t.Fatalf("functionCall %s sent without a signature", part.FunctionCall.Name)
			}
		}
	}
}

// Gemini 2.x does not validate signatures and the placeholder is documented
// for Gemini 3, so older models get the request unchanged.
func TestFillMissingToolSignaturesLeavesOlderModelsAlone(t *testing.T) {
	for _, model := range []string{"gemini-2.5-pro", "gemini-2.5-flash", "custom-model"} {
		req := &GeminiGenerateRequest{Contents: []GeminiContent{
			{Role: "model", Parts: []GeminiPart{{FunctionCall: &GeminiFunctionCall{Name: "a"}}}},
		}}
		if n := FillMissingToolSignatures(req, model); n != 0 || req.Contents[0].Parts[0].ThoughtSignature != "" {
			t.Fatalf("%s: filled %d", model, n)
		}
	}
}
