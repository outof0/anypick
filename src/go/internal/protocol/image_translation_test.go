package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// canaryBase64 stands in for an image payload. It must never reach a text
// field: a translated prompt carrying it would be megabytes of base64 read as
// words.
// imageMarker is spelled out rather than taken from ImageOmitted so this test
// also builds against code that has no marker, and fails there.
const imageMarker = "[image omitted]"

const canaryBase64 = "Q0FOQVJZLWltYWdlLWJ5dGVzLW11c3Qtbm90LWJlLXRleHQ="

// textOf collects every string a model would read as prompt text: string
// contents and the text of text parts. image_url parts are skipped because
// that is where an image is supposed to go.
func textOf(t *testing.T, translated []byte) string {
	t.Helper()
	var req struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(translated, &req); err != nil {
		t.Fatalf("translated request is not JSON: %v\n%s", err, translated)
	}
	var sb strings.Builder
	for _, m := range req.Messages {
		var s string
		if json.Unmarshal(m.Content, &s) == nil {
			sb.WriteString(s + "\n")
			continue
		}
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(m.Content, &parts) == nil {
			for _, p := range parts {
				if p.Type == "text" {
					sb.WriteString(p.Text + "\n")
				}
			}
		}
	}
	return sb.String()
}

func imageURLsOf(t *testing.T, translated []byte) []string {
	t.Helper()
	var req struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(translated, &req); err != nil {
		t.Fatal(err)
	}
	var urls []string
	for _, m := range req.Messages {
		var parts []struct {
			Type     string `json:"type"`
			ImageURL struct {
				URL string `json:"url"`
			} `json:"image_url"`
		}
		if json.Unmarshal(m.Content, &parts) == nil {
			for _, p := range parts {
				if p.Type == "image_url" {
					urls = append(urls, p.ImageURL.URL)
				}
			}
		}
	}
	return urls
}

func TestAnthropicImagesNeverBecomePromptText(t *testing.T) {
	base64Image := `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + canaryBase64 + `"}}`
	cases := []struct {
		name       string
		messages   string
		wantURLs   []string
		wantMarker bool
	}{
		{
			name:     "user base64 image becomes an image_url part",
			messages: `[{"role":"user","content":[{"type":"text","text":"what is this"},` + base64Image + `]}]`,
			wantURLs: []string{"data:image/png;base64," + canaryBase64},
		},
		{
			name:     "user url image keeps its URL",
			messages: `[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://example.test/cat.png"}}]}]`,
			wantURLs: []string{"https://example.test/cat.png"},
		},
		{
			name:       "an image inside a tool result is named, not dropped",
			messages:   `[{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"shot","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"done"},` + base64Image + `]}]}]`,
			wantMarker: true,
		},
		{
			name:       "an assistant image is named, not dropped",
			messages:   `[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"text","text":"here"},` + base64Image + `]}]`,
			wantMarker: true,
		},
		{
			name:       "an image source with no payload is named, not sent empty",
			messages:   `[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":""}}]}]`,
			wantMarker: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := []byte(`{"model":"m","max_tokens":8,"messages":` + tc.messages + `}`)
			out, err := TranslateRequest(body)
			if err != nil {
				t.Fatal(err)
			}
			text := textOf(t, out)
			if strings.Contains(text, canaryBase64) {
				t.Fatalf("image bytes leaked into prompt text:\n%s", text)
			}
			if tc.wantMarker && !strings.Contains(text, imageMarker) {
				t.Fatalf("the image vanished without a marker:\n%s", text)
			}
			urls := imageURLsOf(t, out)
			if len(tc.wantURLs) > 0 && strings.Join(urls, ",") != strings.Join(tc.wantURLs, ",") {
				t.Fatalf("image_url parts = %v, want %v", urls, tc.wantURLs)
			}
			for _, url := range urls {
				if url == "" || url == "data:;base64," {
					t.Fatalf("an empty image_url was sent: %q", url)
				}
			}
		})
	}
}
