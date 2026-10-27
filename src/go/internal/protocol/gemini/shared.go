package gemini

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
	"strings"

	"github.com/outof0/anypick/go/internal/protocol"
)

const idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// RandomID returns a short random base36-ish id, mirroring
// Math.random().toString(36).slice(2, 12) in translate-shared.ts.
func RandomID() string {
	b := make([]byte, 10)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(idAlphabet))))
		if err != nil {
			b[i] = idAlphabet[0]
			continue
		}
		b[i] = idAlphabet[n.Int64()]
	}
	return string(b)
}

// MessageText extracts the textual content of an OpenAI message.
func MessageText(msg OpenAIMessage) string {
	if len(msg.Content) > 0 {
		var s string
		if json.Unmarshal(msg.Content, &s) == nil {
			return s
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(msg.Content, &blocks) == nil {
			parts := make([]string, 0, len(blocks))
			for _, b := range blocks {
				switch {
				case b.Type == "text" && b.Text != "":
					parts = append(parts, b.Text)
				case b.Type == "image_url":
					// The text-only paths cannot send it; say it was there.
					parts = append(parts, protocol.ImageOmitted)
				}
			}
			return strings.Join(parts, "\n")
		}
	}
	return ""
}

// FlattenResponsesText renders an OpenAI Responses input/output value to a
// single string (string, array of text blocks, or object with text/content).
func FlattenResponsesText(value interface{}) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case []interface{}:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			if t := FlattenResponsesText(item); t != "" {
				parts = append(parts, t)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]interface{}:
		if marker, ok := binaryInputMarker(v); ok {
			return marker
		}
		if s, ok := v["text"].(string); ok && s != "" {
			return s
		}
		if c, ok := v["content"]; ok {
			return FlattenResponsesText(c)
		}
		if o, ok := v["output"]; ok {
			return FlattenResponsesText(o)
		}
		// An unrecognised item is kept as JSON so the model still sees it,
		// but never with an inline payload: a data URL here would be read as
		// megabytes of prompt.
		if raw, err := json.Marshal(redactDataURLs(v)); err == nil {
			return string(raw)
		}
		return ""
	default:
		return ""
	}
}

// binaryInputMarker names a Responses item that carries an image, file or audio
// payload. Those cannot travel as text, and their JSON is mostly base64.
func binaryInputMarker(item map[string]interface{}) (string, bool) {
	switch typ, _ := item["type"].(string); typ {
	case "input_image", "output_image", "image", "image_url":
		return protocol.ImageOmitted, true
	case "input_file":
		return "[file omitted]", true
	case "input_audio":
		return "[audio omitted]", true
	}
	return "", false
}

// redactDataURLs returns a copy of v with every data: URL string replaced, at
// any depth.
func redactDataURLs(v interface{}) interface{} {
	switch t := v.(type) {
	case string:
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(t)), "data:") {
			return "[data omitted]"
		}
		return t
	case []interface{}:
		out := make([]interface{}, len(t))
		for i, item := range t {
			out[i] = redactDataURLs(item)
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(t))
		for k, item := range t {
			out[k] = redactDataURLs(item)
		}
		return out
	default:
		return v
	}
}

// SafeParseObject parses a JSON string into a map, tolerating non-object and
// malformed input (falls back to {value: <decoded-or-raw>} / {raw}).
func SafeParseObject(raw string) map[string]interface{} {
	if raw == "" {
		return map[string]interface{}{}
	}
	var v interface{}
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return map[string]interface{}{"raw": raw}
	}
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return map[string]interface{}{"value": v}
}

// MapGeminiFinish maps a Gemini finishReason to an OpenAI finish_reason.
func MapGeminiFinish(reason string, hasTools bool) string {
	if hasTools {
		return "tool_calls"
	}
	switch reason {
	case "MAX_TOKENS":
		return "length"
	case "STOP", "FINISH_REASON_UNSPECIFIED", "":
		return "stop"
	default:
		return "stop"
	}
}

// MapGeminiFinishToAnthropic maps a Gemini finishReason to an Anthropic
// stop_reason.
func MapGeminiFinishToAnthropic(reason string, hasTools bool) string {
	if hasTools {
		return "tool_use"
	}
	if reason == "MAX_TOKENS" {
		return "max_tokens"
	}
	return "end_turn"
}

// asStringSlice decodes a json.RawMessage stop field that may be a string or
// an array of strings.
func asStringSlice(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && s != "" {
		return []string{s}
	}
	var ss []string
	if json.Unmarshal(raw, &ss) == nil {
		return ss
	}
	return nil
}
