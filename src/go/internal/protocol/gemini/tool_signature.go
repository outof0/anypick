package gemini

// SkipThoughtSignature is the placeholder Google documents for a functionCall
// whose thought signature was never kept, such as history written by another
// model or by a client that dropped it. Gemini 3 otherwise rejects the request
// ("Function call is missing a thought_signature in functionCall parts").
const SkipThoughtSignature = "skip_thought_signature_validator"

// FillMissingToolSignatures gives the first functionCall part of each model
// step the placeholder signature when it has none, and reports how many it
// filled. Gemini validates only that part of a step, and a real signature is
// never replaced. A conversation that lost its signatures before AnyPick kept
// them (Codex dropped the carrier item until 1.2.1) can then continue instead
// of failing on every later turn.
//
// Only Gemini 3 and later validate signatures, and the placeholder is
// documented for them; older models get the request unchanged.
func FillMissingToolSignatures(req *GeminiGenerateRequest, upstreamModel string) int {
	if req == nil || ParseGeminiModelVersion(upstreamModel)[0] < 3 {
		return 0
	}
	filled := 0
	for i := range req.Contents {
		content := &req.Contents[i]
		if content.Role != "model" {
			continue
		}
		for j := range content.Parts {
			part := &content.Parts[j]
			if part.FunctionCall == nil {
				continue
			}
			if part.ThoughtSignature == "" {
				part.ThoughtSignature = SkipThoughtSignature
				filled++
			}
			break
		}
	}
	return filled
}
