package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/safepath"
)

// WriteTo writes this paste's files into a directory PrepareSnapshot already
// created. It rejects absolute paths, parent segments, and empty names, and
// it does not touch the live credential directory.
func (p PastedSnapshot) WriteTo(destDir string) error {
	if len(p.files) == 0 {
		return authJSONNotValid()
	}
	for name, body := range p.files {
		if !singlePasteFile(name) {
			return authPasteFileNameRefused()
		}
		if err := os.WriteFile(filepath.Join(destDir, name), body, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func singlePasteFile(name string) bool {
	return safepath.ValidateName(name) == nil
}

// authPasteFileNameRefused never echoes the pasted name or value.
func authPasteFileNameRefused() error {
	return anyerr.Newf("This login data includes a file name AnyPick can't use, so nothing was saved. Copy it again from the provider.", "AUTH_DOCUMENT_INVALID")
}

func (p *codex) PlanAuthPaste(raw []byte) ([]PastedSnapshot, error) {
	return planProviderAuthPaste(raw, planCodexDocument)
}

func (p *claude) PlanAuthPaste(raw []byte) ([]PastedSnapshot, error) {
	return planProviderAuthPaste(raw, planClaudeDocument)
}

func planProviderAuthPaste(raw []byte, one func(json.RawMessage) (PastedSnapshot, error)) ([]PastedSnapshot, error) {
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, authJSONNotValid()
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if raw[0] == '[' {
		var elems []json.RawMessage
		if err := dec.Decode(&elems); err != nil {
			return nil, authJSONNotValid()
		}
		if err := rejectTrailingJSON(dec); err != nil {
			return nil, authJSONNotValid()
		}
		if len(elems) == 0 || len(elems) > MaxAuthPasteAccounts {
			return nil, authPasteListInvalid()
		}
		out := make([]PastedSnapshot, 0, len(elems))
		for _, el := range elems {
			snap, err := one(el)
			if err != nil {
				return nil, err
			}
			out = append(out, snap)
		}
		return out, nil
	}
	var doc json.RawMessage
	if err := dec.Decode(&doc); err != nil {
		return nil, authJSONNotValid()
	}
	if err := rejectTrailingJSON(dec); err != nil {
		return nil, authJSONNotValid()
	}
	snap, err := one(doc)
	if err != nil {
		return nil, err
	}
	return []PastedSnapshot{snap}, nil
}

func rejectTrailingJSON(dec *json.Decoder) error {
	var extra any
	err := dec.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return errors.New("trailing JSON value")
	}
	return err
}

func planCodexDocument(raw json.RawMessage) (PastedSnapshot, error) {
	var data map[string]json.RawMessage
	if json.Unmarshal(raw, &data) != nil {
		return PastedSnapshot{}, codexAuthDocumentInvalid()
	}
	body := cloneBytes(bytes.TrimSpace(raw))
	var connectionEmail string
	if !codexAuthJSON(data) {
		// A ChatGPT connection row (accessToken, idToken, chatgptAccountId)
		// is the document people copy out of another router. Store the Codex
		// auth.json the proxy and Restore already read.
		converted, email, ok := codexAuthFromConnection(data)
		if !ok {
			return PastedSnapshot{}, codexAuthDocumentInvalid()
		}
		body = converted
		connectionEmail = email
		if json.Unmarshal(body, &data) != nil || !codexAuthJSON(data) {
			return PastedSnapshot{}, codexAuthDocumentInvalid()
		}
	}
	info := codexSnapshotInfo(data)
	if connectionEmail != "" && (info.Identity == "" || strings.HasPrefix(info.Identity, "chatgpt:")) {
		info.Identity = connectionEmail
	}
	suggested := codexPasteSuggestedName(data)
	if connectionEmail != "" {
		suggested = connectionEmail
	}
	return PastedSnapshot{
		SuggestedName: suggested,
		Info:          info,
		files:         map[string][]byte{"auth.json": body},
	}, nil
}

// codexAuthFromConnection maps a ChatGPT connection row onto auth.json.
// A bare accessToken is not enough: that string shows up on other providers.
func codexAuthFromConnection(data map[string]json.RawMessage) ([]byte, string, bool) {
	access := strings.TrimSpace(stringField(data, "accessToken"))
	if access == "" {
		return nil, "", false
	}
	refresh := strings.TrimSpace(stringField(data, "refreshToken"))
	idToken := strings.TrimSpace(stringField(data, "idToken"))
	accountID := strings.TrimSpace(codexConnectionAccountID(data))
	if accountID == "" && idToken == "" {
		return nil, "", false
	}
	email := codexConnectionEmail(stringField(data, "name"))
	file := codexPasteAuth{
		AuthMode: "chatgpt",
		Tokens: codexPasteTokens{
			IDToken:      idToken,
			AccessToken:  access,
			RefreshToken: refresh,
			AccountID:    accountID,
		},
		LastRefresh: codexConnectionLastRefresh(data),
	}
	body, err := json.Marshal(file)
	if err != nil {
		return nil, "", false
	}
	return body, email, true
}

func codexConnectionAccountID(data map[string]json.RawMessage) string {
	raw, ok := data["providerSpecificData"]
	if !ok {
		return ""
	}
	var spec map[string]json.RawMessage
	if json.Unmarshal(raw, &spec) != nil {
		return ""
	}
	return stringField(spec, "chatgptAccountId")
}

func codexConnectionEmail(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsAny(name, " \t\r\n") || !strings.Contains(name, "@") {
		return ""
	}
	return name
}

type codexPasteAuth struct {
	AuthMode    string           `json:"auth_mode"`
	Tokens      codexPasteTokens `json:"tokens"`
	LastRefresh string           `json:"last_refresh,omitempty"`
}

// last_refresh is when the access token was issued. The connection row stores
// the expiry and the lifetime, so the issue time is expiry minus expiresIn.
func codexConnectionLastRefresh(data map[string]json.RawMessage) string {
	raw, ok := data["expiresAt"]
	if !ok {
		return ""
	}
	var expiresAt string
	if json.Unmarshal(raw, &expiresAt) != nil {
		return ""
	}
	expires, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(expiresAt))
	if err != nil {
		return ""
	}
	raw, ok = data["expiresIn"]
	if !ok {
		return ""
	}
	var seconds float64
	if json.Unmarshal(raw, &seconds) != nil || seconds <= 0 {
		return ""
	}
	return expires.Add(-time.Duration(seconds * float64(time.Second))).UTC().Format(time.RFC3339Nano)
}

type codexPasteTokens struct {
	IDToken      string `json:"id_token,omitempty"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	AccountID    string `json:"account_id,omitempty"`
}

// Suggested name prefers tokens.account_id so two Codex workspaces under one
// email stay distinct. The email is the fallback. An API-key document has no
// name of its own; the caller must pass one.
func codexPasteSuggestedName(data map[string]json.RawMessage) string {
	if tokensRaw, ok := data["tokens"]; ok {
		var tokens map[string]json.RawMessage
		if json.Unmarshal(tokensRaw, &tokens) == nil {
			if acct := strings.TrimSpace(stringField(tokens, "account_id")); acct != "" {
				return acct
			}
		}
	}
	info := codexSnapshotInfo(data)
	if info.Identity == "" || info.Identity == "API key" {
		return ""
	}
	return info.Identity
}

func planClaudeDocument(raw json.RawMessage) (PastedSnapshot, error) {
	body := cloneBytes(bytes.TrimSpace(raw))
	if _, credential, ok := claudeWrapperFields(body); ok && claudeCredentialOK(credential) {
		return PastedSnapshot{
			SuggestedName: claudePasteEmail(credential),
			Info:          SnapshotInfo{Identity: claudeCredentialIdentity(credential)},
			files:         map[string][]byte{claudeSnapshotFile: body},
		}, nil
	}
	text := string(body)
	if !claudeCredentialOK(text) {
		// Same flat connection row as Codex, without ChatGPT's id token or
		// account id. Those stay on the Codex paste.
		converted, ok := claudeAuthFromConnection(dataFromRaw(body))
		if !ok {
			return PastedSnapshot{}, claudeAuthDocumentInvalid()
		}
		text = converted
	}
	email := claudePasteEmail(text)
	account := email
	if account == "" {
		account = "anypick"
	}
	// A pasted claudeAiOauth object is stored as the user wrote it. A flat
	// connection row is mapped onto that object first.
	wrapped, err := json.Marshal(struct {
		Version    int    `json:"version"`
		Account    string `json:"account"`
		Credential string `json:"credential"`
	}{Version: 1, Account: account, Credential: text})
	if err != nil {
		return PastedSnapshot{}, claudeAuthDocumentInvalid()
	}
	return PastedSnapshot{
		SuggestedName: email,
		Info:          SnapshotInfo{Identity: claudeCredentialIdentity(text)},
		files:         map[string][]byte{claudeSnapshotFile: wrapped},
	}, nil
}

func dataFromRaw(raw []byte) map[string]json.RawMessage {
	var data map[string]json.RawMessage
	if json.Unmarshal(raw, &data) != nil {
		return nil
	}
	return data
}

// claudeAuthFromConnection maps a flat accessToken row onto claudeAiOauth.
// A ChatGPT row carries idToken or chatgptAccountId and is left for Codex.
func claudeAuthFromConnection(data map[string]json.RawMessage) (string, bool) {
	if data == nil {
		return "", false
	}
	if _, ok := data["claudeAiOauth"]; ok {
		return "", false
	}
	if strings.TrimSpace(stringField(data, "idToken")) != "" || codexConnectionAccountID(data) != "" {
		return "", false
	}
	access := strings.TrimSpace(stringField(data, "accessToken"))
	refresh := strings.TrimSpace(stringField(data, "refreshToken"))
	if access == "" && refresh == "" {
		return "", false
	}
	oauth := map[string]any{}
	if access != "" {
		oauth["accessToken"] = access
	}
	if refresh != "" {
		oauth["refreshToken"] = refresh
	}
	email := codexConnectionEmail(stringField(data, "name"))
	if email == "" {
		email = codexConnectionEmail(stringField(data, "email"))
	}
	if email != "" {
		oauth["email"] = email
	}
	if raw, ok := data["expiresAt"]; ok {
		var expires any
		if json.Unmarshal(raw, &expires) == nil {
			oauth["expiresAt"] = expires
		}
	}
	if plan := strings.TrimSpace(stringField(data, "subscriptionType")); plan != "" {
		oauth["subscriptionType"] = plan
	}
	body, err := json.Marshal(map[string]any{"claudeAiOauth": oauth})
	if err != nil {
		return "", false
	}
	if !claudeCredentialOK(string(body)) {
		return "", false
	}
	return string(body), true
}

func claudeWrapperFields(raw []byte) (account, credential string, ok bool) {
	var doc struct {
		Version    *int   `json:"version"`
		Account    string `json:"account"`
		Credential string `json:"credential"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Version == nil || *doc.Version != 1 ||
		doc.Account == "" || doc.Credential == "" {
		return "", "", false
	}
	return doc.Account, doc.Credential, true
}

func claudeCredentialOK(raw string) bool {
	var root map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &root) != nil {
		return false
	}
	oauthRaw, ok := root["claudeAiOauth"]
	if !ok {
		return false
	}
	var oauth map[string]json.RawMessage
	if json.Unmarshal(oauthRaw, &oauth) != nil {
		return false
	}
	return strings.TrimSpace(stringField(oauth, "accessToken")) != "" ||
		strings.TrimSpace(stringField(oauth, "refreshToken")) != ""
}

// The name is the email only. A subscription plan label is a display identity,
// not something the user would recognize as the account's name.
func claudePasteEmail(raw string) string {
	var root map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &root) != nil {
		return ""
	}
	if email := strings.TrimSpace(stringField(root, "email")); email != "" {
		return email
	}
	oauthRaw, ok := root["claudeAiOauth"]
	if !ok {
		return ""
	}
	var oauth map[string]json.RawMessage
	if json.Unmarshal(oauthRaw, &oauth) != nil {
		return ""
	}
	return strings.TrimSpace(stringField(oauth, "email"))
}

func cloneBytes(b []byte) []byte {
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

func authJSONNotValid() error {
	return anyerr.Newf("Auth JSON is not valid.", "AUTH_DOCUMENT_INVALID")
}

func authPasteListInvalid() error {
	return anyerr.Newf("A pasted list can contain at most 32 accounts.", "AUTH_DOCUMENT_INVALID")
}

func codexAuthDocumentInvalid() error {
	return anyerr.Newf(
		"Codex auth JSON must be an object with OPENAI_API_KEY or tokens.access_token, tokens.refresh_token, or tokens.id_token, a ChatGPT connection with accessToken plus idToken or chatgptAccountId, or a list of those objects.",
		"AUTH_DOCUMENT_INVALID")
}

func claudeAuthDocumentInvalid() error {
	return anyerr.Newf(
		"Claude auth JSON must be a claudeAiOauth object with accessToken or refreshToken, a connection row with accessToken or refreshToken, an AnyPick credentials wrapper, or a list of those.",
		"AUTH_DOCUMENT_INVALID")
}
