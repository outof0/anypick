package gemini

import (
	"encoding/json"
	"strings"
	"testing"
)

// imageMarker is spelled out rather than taken from protocol.ImageOmitted so
// this test also builds against code that has no marker, and fails there.
const imageMarker = "[image omitted]"

// canaryDataURL stands in for an inline image. Before this was fixed, an
// input_image fell through to json.Marshal and the whole data URL was sent to
// the model as prompt text.
const canaryDataURL = "data:image/png;base64,Q0FOQVJZLXJlc3BvbnNlcy1pbWFnZQ=="

func responsesRequest(t *testing.T, input string) OpenAIResponsesRequest {
	t.Helper()
	var req OpenAIResponsesRequest
	if err := json.Unmarshal([]byte(`{"model":"m","input":`+input+`}`), &req); err != nil {
		t.Fatal(err)
	}
	return req
}

func TestResponsesImagesNeverBecomePromptText(t *testing.T) {
	cases := []struct {
		name       string
		input      string
		wantImage  string
		wantMarker string
	}{
		{
			name:      "user input_image becomes an image_url part",
			input:     `[{"role":"user","content":[{"type":"input_text","text":"what is this"},{"type":"input_image","image_url":"` + canaryDataURL + `","detail":"high"}]}]`,
			wantImage: canaryDataURL,
		},
		{
			name:      "an https input_image keeps its URL",
			input:     `[{"role":"user","content":[{"type":"input_image","image_url":"https://example.test/cat.png"}]}]`,
			wantImage: "https://example.test/cat.png",
		},
		{
			name:       "a file_id image has no Chat form and is named",
			input:      `[{"role":"user","content":[{"type":"input_image","file_id":"file_123"}]}]`,
			wantMarker: imageMarker,
		},
		{
			name:       "an image in a tool output is named",
			input:      `[{"type":"function_call","call_id":"c1","name":"shot","arguments":"{}"},{"type":"function_call_output","call_id":"c1","output":[{"type":"input_image","image_url":"` + canaryDataURL + `"}]}]`,
			wantMarker: imageMarker,
		},
		{
			name:       "an inline file is named",
			input:      `[{"role":"user","content":[{"type":"input_file","filename":"a.pdf","file_data":"` + canaryDataURL + `"}]}]`,
			wantMarker: "[file omitted]",
		},
		{
			name:       "an unknown item keeps its shape without its payload",
			input:      `[{"role":"user","content":[{"type":"input_future","blob":"` + canaryDataURL + `"}]}]`,
			wantMarker: "[data omitted]",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			chat := OpenAIResponsesToChat(responsesRequest(t, tc.input), "m")
			var text strings.Builder
			var images []string
			for _, msg := range chat.Messages {
				text.WriteString(MessageText(msg) + "\n")
				var parts []struct {
					Type     string `json:"type"`
					ImageURL struct {
						URL string `json:"url"`
					} `json:"image_url"`
				}
				if json.Unmarshal(msg.Content, &parts) == nil {
					for _, p := range parts {
						if p.Type == "image_url" {
							images = append(images, p.ImageURL.URL)
						}
					}
				}
			}
			if strings.Contains(text.String(), "base64,") {
				t.Fatalf("image bytes leaked into prompt text:\n%s", text.String())
			}
			if tc.wantImage != "" && (len(images) != 1 || images[0] != tc.wantImage) {
				t.Fatalf("image_url parts = %v, want [%s]", images, tc.wantImage)
			}
			if tc.wantMarker != "" && !strings.Contains(text.String(), tc.wantMarker) {
				t.Fatalf("want marker %q in:\n%s", tc.wantMarker, text.String())
			}
		})
	}
}

// The Gemini paths carry text only: an image must be named there, and never
// arrive as its encoded bytes.
func TestResponsesImageOnGeminiIsNamedNotEncoded(t *testing.T) {
	req := responsesRequest(t, `[{"role":"user","content":[{"type":"input_text","text":"look"},{"type":"input_image","image_url":"`+canaryDataURL+`"}]}]`)
	gem := OpenAIResponsesToGemini(req, "gemini-test")
	raw, err := json.Marshal(gem)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "base64,") {
		t.Fatalf("image bytes reached the Gemini request:\n%s", raw)
	}
	if !strings.Contains(string(raw), imageMarker) {
		t.Fatalf("the image vanished without a marker:\n%s", raw)
	}
}
