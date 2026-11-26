package provider

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/protocol"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transport"
)

// workbuddy is the WorkBuddy AI / CodeBuddy subscription account source.
//
// AnyPick cannot borrow an official CLI to sign in — no CodeBuddy CLI ships
// on the user's machine — so it runs Tencent's own OAuth device flow itself,
// the same one the official CLI uses, and stages the resulting token before
// saving.
//
// Three files are involved and the desktop app owns the live one:
//
//	<app-data>/Data/Public/auth/workbuddy-desktop-ai.info   live, native
//	~/.workbuddy/auth.json                                  staging (device flow)
//	~/.anypick/providers/workbuddy/accounts/<name>/…        the snapshot
//
// The native session is the app's FileAuthenticationStorage document
// (plaintext JSON carrying auth.accessToken); switching accounts restores it
// like any other provider's live file, so the running app follows. The
// staging file exists only because core's login sequence is
// Login → DetectLive → Backup with no way to skip the middle step, and Login
// is not handed a destination directory. Every consumer, including the proxy,
// reads the snapshot.
//
// API-key accounts are deliberately not supported here — the `tokenhub`
// compatible provider already covers Tencent's pay-as-you-go and Coding Plan
// keys with the real endpoints.
type workbuddy struct{ home string }

func newWorkBuddy(home string) *workbuddy { return &workbuddy{home: home} }

var _ LiveMatcher = (*workbuddy)(nil)

const (
	workbuddyAuthFile    = "auth.json"
	workbuddyAuthVersion = 1
	workbuddyKindSub     = "subscription"
)

// workbuddyAuthDocument is the token document AnyPick writes and reads.
type workbuddyAuthDocument struct {
	Version     int    `json:"version"`
	Kind        string `json:"kind"`
	MethodID    string `json:"methodId,omitempty"`
	Base        string `json:"base,omitempty"`
	Domain      string `json:"domain,omitempty"`
	AccessToken string `json:"accessToken,omitempty"`
	// RefreshToken is written but never read: AnyPick has no token-refresh
	// machinery at all — no Refresher interface, no expiry column in the
	// account meta — so an expired token currently means signing in again.
	// It is kept so adding refresh later does not force every existing
	// account through a full browser re-login.
	RefreshToken string `json:"refreshToken,omitempty"`
	UserID       string `json:"userId,omitempty"`
	ObtainedAt   string `json:"obtainedAt,omitempty"`
}

func (p *workbuddy) ID() string          { return "workbuddy" }
func (p *workbuddy) Name() string        { return "WorkBuddy AI" }
func (p *workbuddy) ShortName() string   { return "WorkBuddy" }
func (p *workbuddy) Description() string { return "WorkBuddy AI and CodeBuddy subscription accounts" }
func (p *workbuddy) CanProxy() bool      { return true }

func (p *workbuddy) AccountAdapter(accountName string, _ bool) transport.Adapter {
	return transport.WorkBuddyAccountAdapter(p.ID(), accountName)
}

// authPath is where AnyPick keeps its staging credential.
//
// It deliberately ignores WORKBUDDY_CONFIG_DIR and CODEBUDDY_CONFIG_DIR.
// Those are the WorkBuddy app's own variables and it exports them into every
// process it spawns, so honouring them would put this file under
// ~/.workbuddy-ai when AnyPick runs inside the app and under ~/.workbuddy
// when it runs from a plain Terminal — the same account would read as logged
// in or not depending on where the command was typed. Nothing outside AnyPick
// opens this file, so a fixed path costs nothing and is the only stable one.
// WORKBUDDY_AUTH_PATH stays as an explicit escape hatch for tests.
func (p *workbuddy) authPath() string {
	if env := strings.TrimSpace(os.Getenv("WORKBUDDY_AUTH_PATH")); env != "" {
		return expandHome(env)
	}
	return filepath.Join(expandHome(p.home), ".workbuddy", workbuddyAuthFile)
}

// readAuthDocument returns nil without an error when the file is missing or is
// not a credential AnyPick wrote. A file we cannot parse is not a login.
//
// The stored UserID is refreshed from the token on every read: documents
// written before the email identity existed still carry a bare uid, and the
// token is the authority on who the login belongs to. Opaque tokens keep
// their stored value.
func readWorkBuddyAuthDocument(path string) (*workbuddyAuthDocument, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return parseWorkBuddyAuthDocument(raw), nil
}

func parseWorkBuddyAuthDocument(raw []byte) *workbuddyAuthDocument {
	var doc workbuddyAuthDocument
	if json.Unmarshal(raw, &doc) != nil || doc.AccessToken == "" {
		return nil
	}
	if id := workbuddyTokenIdentity(doc.AccessToken); id != "" {
		doc.UserID = id
	}
	return &doc
}

func writeWorkBuddyAuthDocument(path string, doc workbuddyAuthDocument) error {
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	// Same helper writes AnyPick staging and (via merge) the live session
	// input (ADR 0004): rename in both cases.
	return atomicfile.Write(path, append(data, '\n'), 0o600)
}

// activeDoc returns the current live credential document, reconciling the
// device-flow staging file (~/.workbuddy/auth.json) with the desktop app's
// native session file (workbuddy-desktop-ai.info). When both exist, the more
// recently modified file wins so switches made inside the WorkBuddy app are
// reflected, while a freshly staged login still takes precedence over an older
// session.
func (p *workbuddy) activeDoc() (*workbuddyAuthDocument, error) {
	stagingPath := p.authPath()
	nativePath := workbuddyNativeAuthPath(p.home)

	stagingDoc, stagingErr := readWorkBuddyAuthDocument(stagingPath)
	if stagingErr != nil {
		return nil, stagingErr
	}
	nativeDoc, nativeErr := readWorkBuddyNativeDoc(nativePath)
	if nativeErr != nil {
		return nil, nativeErr
	}

	if stagingDoc == nil && nativeDoc == nil {
		return nil, nil
	}
	if stagingDoc != nil && nativeDoc == nil {
		return stagingDoc, nil
	}
	if stagingDoc == nil && nativeDoc != nil {
		return nativeDoc, nil
	}

	stagingFi, sErr := os.Stat(stagingPath)
	nativeFi, nErr := os.Stat(nativePath)
	if sErr == nil && nErr == nil && nativeFi.ModTime().After(stagingFi.ModTime()) {
		return nativeDoc, nil
	}
	return stagingDoc, nil
}

func (p *workbuddy) DetectLive() (LiveAuthStatus, error) {
	doc, err := p.activeDoc()
	if err != nil {
		return LiveAuthStatus{}, err
	}
	if doc == nil {
		return LiveAuthStatus{}, nil
	}
	return LiveAuthStatus{Present: true, Identity: doc.UserID}, nil
}

func (p *workbuddy) LoginMethods() []LoginMethod {
	methods := make([]LoginMethod, 0, len(workbuddySites))
	for _, site := range workbuddySites {
		methods = append(methods, LoginMethod{
			ID:          site.MethodID,
			Label:       site.Label,
			Description: site.Description,
			// Not "official": these endpoints are undocumented and Tencent
			// can change them without notice, so users should know AnyPick
			// is on its own here.
			Provenance: "community",
			Preferred:  site.Preferred,
			// The flow is plain HTTPS against a public service; there is no
			// launcher binary that could be missing.
			Available: true,
		})
	}
	return methods
}

func (p *workbuddy) Login(ctx context.Context, methodID, source string) error {
	if source != "" {
		return anyerr.Newf(
			"WorkBuddy sign-in has no separate sources.",
			"PROVIDER_LOGIN_METHOD_UNKNOWN")
	}
	site, ok := workbuddySiteByMethod(methodID)
	if !ok {
		return anyerr.Newf("Unknown WorkBuddy sign-in method.", "PROVIDER_LOGIN_METHOD_UNKNOWN")
	}
	token, err := workbuddyDeviceLogin(ctx, site)
	if err != nil {
		return err
	}
	domain := token.Domain
	if domain == "" {
		domain = site.Domain
	}
	doc := workbuddyAuthDocument{
		Version:      workbuddyAuthVersion,
		Kind:         workbuddyKindSub,
		MethodID:     site.MethodID,
		Base:         site.Base,
		Domain:       domain,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		UserID:       workbuddyTokenIdentity(token.AccessToken),
		ObtainedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := writeWorkBuddyAuthDocument(p.authPath(), doc); err != nil {
		return err
	}
	// The desktop app only follows its own session file, so a sign-in must
	// land there too — otherwise the app keeps showing the previous login
	// while AnyPick already points at the new one.
	return writeWorkBuddyNativeSession(workbuddyNativeAuthPath(p.home), doc)
}

// ClearLive drops the staging file and the desktop app's session. There is no
// server-side logout to call: revoking a subscription session is not part of
// the endpoint we use. Callers checkpoint first (the login flow does), so a
// cancelled sign-in still restores the previous session.
func (p *workbuddy) ClearLive() error {
	err := os.Remove(p.authPath())
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Remove(workbuddyNativeAuthPath(p.home)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Backup saves the live login from whichever file is current (reconciled by
// activeDoc). It reports native so core restores the session on switch like
// every other file-backed provider — that restore is what moves the running app
// between accounts.
func (p *workbuddy) Backup(destDir string) (SnapshotInfo, error) {
	doc, err := p.activeDoc()
	if err != nil {
		return SnapshotInfo{}, err
	}
	if doc == nil {
		return SnapshotInfo{}, anyerr.Newf(
			"No live WorkBuddy login to save.",
			"NO_LIVE_AUTH",
			anyerr.WithSuggestions("Run `anypick login workbuddy` first."))
	}
	if err := writeWorkBuddyAuthDocument(filepath.Join(destDir, workbuddyAuthFile), *doc); err != nil {
		return SnapshotInfo{}, err
	}
	return SnapshotInfo{
		Identity:        doc.UserID,
		CredentialKind:  "native",
		CredentialClass: "external_oauth",
	}, nil
}

func (p *workbuddy) Restore(srcDir string) error {
	doc, err := readWorkBuddyAuthDocument(filepath.Join(srcDir, workbuddyAuthFile))
	if err != nil {
		return err
	}
	if doc == nil {
		return errSnapshotMissing(workbuddyAuthFile)
	}
	if err := writeWorkBuddyAuthDocument(p.authPath(), *doc); err != nil {
		return err
	}
	return writeWorkBuddyNativeSession(workbuddyNativeAuthPath(p.home), *doc)
}

func (p *workbuddy) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	doc, err := readWorkBuddyAuthDocument(filepath.Join(srcDir, workbuddyAuthFile))
	if err != nil {
		return SnapshotInfo{}, err
	}
	if doc == nil {
		return SnapshotInfo{}, nil
	}
	return SnapshotInfo{
		Identity:        doc.UserID,
		CredentialKind:  "native",
		CredentialClass: "external_oauth",
	}, nil
}

// SnapshotMatchesLive compares the saved snapshot's credentials against the
// active live session. A match is found if the access tokens are identical,
// if their subject claims match, or if their identities match.
func (p *workbuddy) SnapshotMatchesLive(srcDir string) (bool, bool, error) {
	return p.SnapshotFilesMatchLive(snapshotFilesAt(srcDir))
}

func (p *workbuddy) SnapshotFilesMatchLive(file SnapshotFileReader) (bool, bool, error) {
	raw, err := file(workbuddyAuthFile)
	if os.IsNotExist(err) {
		return false, true, nil
	}
	if err != nil {
		return false, false, err
	}
	snapDoc := parseWorkBuddyAuthDocument(raw)
	if snapDoc == nil || snapDoc.AccessToken == "" {
		return false, true, nil
	}
	liveDoc, err := p.activeDoc()
	if err != nil {
		return false, false, err
	}
	if liveDoc == nil || liveDoc.AccessToken == "" {
		return false, true, nil
	}
	if liveDoc.AccessToken == snapDoc.AccessToken {
		return true, true, nil
	}
	liveSub := workbuddyTokenSubject(liveDoc.AccessToken)
	snapSub := workbuddyTokenSubject(snapDoc.AccessToken)
	if liveSub != "" && snapSub != "" && liveSub == snapSub {
		return true, true, nil
	}
	if liveDoc.UserID != "" && snapDoc.UserID != "" && strings.EqualFold(liveDoc.UserID, snapDoc.UserID) {
		return true, true, nil
	}
	return false, true, nil
}

// ValidateSnapshot fails fast on an expired subscription token. AnyPick has
// no token-refresh machinery, so an expired token can only be repaired by
// signing in again — better reported here than as a proxy 401 on the first
// forwarded request.
func (p *workbuddy) ValidateSnapshot(snapshotDir string) error {
	doc, err := readWorkBuddyAuthDocument(filepath.Join(snapshotDir, workbuddyAuthFile))
	if err != nil || doc == nil || doc.AccessToken == "" {
		// Presence is ValidateCredential's check, not this one.
		return err
	}
	exp, ok := workbuddyTokenExpiry(doc.AccessToken)
	if !ok {
		return nil
	}
	if !time.Now().Add(time.Minute).Before(exp) {
		return anyerr.Newf(
			"The saved WorkBuddy login has expired. Sign in again to repair it.",
			"AUTH_REQUIRED",
			anyerr.WithExitCode(anyerr.AuthRequired),
			anyerr.WithSuggestions("anypick add account workbuddy --new --name <name>"))
	}
	return nil
}

// ResolveUpstream points the shared OpenAI-compatible loopback proxy at the
// WorkBuddy/CodeBuddy chat endpoint. The host comes from the credential or the
// installed product, never from a package default: a token issued by
// copilot.tencent.com is rejected by www.codebuddy.ai, so guessing would be
// wrong for half the users.
func (p *workbuddy) ResolveUpstream(snapshotDir string) (*proxy.Upstream, error) {
	doc, err := readWorkBuddyAuthDocument(filepath.Join(snapshotDir, workbuddyAuthFile))
	if err != nil {
		return nil, err
	}
	if doc == nil || doc.AccessToken == "" {
		return nil, anyerr.Newf(
			"No WorkBuddy credential in this snapshot.", "NO_CREDENTIAL",
			anyerr.WithSuggestions("Save a subscription login: `anypick login workbuddy`."))
	}
	// WORKBUDDY_BASE_URL overrides the whole upstream base, including /v2.
	// It exists for testing against a local stand-in.
	base := strings.TrimSpace(os.Getenv("WORKBUDDY_BASE_URL"))
	if base == "" {
		origin := strings.TrimSuffix(strings.TrimSpace(doc.Base), "/")
		// The chat surface belongs to the product the desktop app resolved for
		// this installation (`endpoint` in its ACC_PRODUCT_CONFIG_V3), not to
		// the site that issued the device-flow token: WorkBuddy's app calls
		// www.workbuddy.ai, while the token may come from www.codebuddy.ai —
		// both are auth "external domains", but only the product endpoint is
		// the subscription's chat edge (the other edge answers APISIX
		// 502/504s under load). China installations keep their own host: a
		// token issued by copilot.tencent.com is rejected elsewhere.
		if product := workbuddyProductEndpoint(p.home); product != "" && !workbuddyChinaOrigin(origin) {
			origin = product
		}
		base = origin + "/v2"
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse WorkBuddy upstream base", "PROXY_START_FAILED")
	}
	// A snapshot written before the issuing host was recorded (or a blank
	// Base) parses as a path-only URL with no host. The loopback health
	// check would still pass and the failure would only surface on the first
	// forwarded request with a confusing error — fail here instead, while the
	// user can still act on it.
	if !u.IsAbs() || u.Hostname() == "" {
		return nil, anyerr.Newf(
			"The saved WorkBuddy login has no usable endpoint. Sign in again to repair it.",
			"PROXY_START_FAILED",
			anyerr.WithSuggestions("anypick add account workbuddy --new --name <name>"),
		)
	}
	domain := strings.TrimSpace(doc.Domain)
	if domain == "" {
		if site, ok := workbuddySiteByMethod(doc.MethodID); ok {
			domain = site.Domain
		}
	}
	headers := []proxy.ExtraHeader{
		{Name: "User-Agent", Value: workbuddyUserAgent},
		{Name: "X-Product", Value: "SaaS"},
	}
	if domain != "" {
		headers = append(headers, proxy.ExtraHeader{Name: "X-Domain", Value: domain})
	}
	return newWorkBuddyUpstream(u, doc.AccessToken, headers, p.home), nil
}

func newWorkBuddyUpstream(base *url.URL, token string, headers []proxy.ExtraHeader, home string) *proxy.Upstream {
	return &proxy.Upstream{
		BaseURL:            base,
		Auth:               token,
		AuthHeader:         "Authorization",
		AuthValuePrefix:    "Bearer ",
		ExtraHeaders:       headers,
		DynamicHeaders:     workbuddyDynamicHeaders(),
		ModelDiscovery:     workbuddyModelDiscovery(home),
		TranslateAnthropic: true,
		// The subscription chat surface is …/v2/chat/completions: the
		// inbound /v1/… path must never reach the vendor, which reads it
		// as an API-key channel marker and rejects the call (code 11128).
		OpenAIPath: "/chat/completions",
		// Claude Code's system prompt carries an x-anthropic-billing-header
		// line the vendor's filter reads as channel spoofing (same 11128).
		// Subscription chat also requires a system-first message. Model id
		// is left untouched: the caller must send a slug the vendor
		// actually serves.
		SanitizeOpenAIBody: workbuddySanitizeOpenAIBody,
		// 6004 is WorkBuddy's per-model frequency limit. 14018 is the
		// account-level credit exhaustion the same edge reports as
		// `{"error":{"data":{"code":14018,"msg":"Credits exhausted..."}}}`
		// — a nested `data` object, so neither IsCredentialQuotaFailure (it
		// wants `resource exhausted` or a key/balance attribution) nor any
		// balance regex below matches it. Unclassified, isQuotaRefusal
		// returned false, serveChain replayed the 429 to the caller, and every
		// other account in the hub went untried even though they serve the
		// model. Both are credential-scoped, so both must rotate the account.
		// Both codes are anchored to the JSON "code" field: a bare 14018 also
		// matched "140182 tokens" in an unrelated error body, which rotated a
		// healthy account into cooldown. 14018 is matched, not the phrase
		// "credits exhausted": MatchesQuotaErrorPattern compiles these
		// case-sensitively and the vendor capitalises the phrase.
		QuotaErrorPatterns: []string{
			"quota", "balance", "insufficient", "billing",
			"frequency limit", "usage exceeds frequency limit",
			`"code":\s*"?6004"?`, `"code":\s*"?14018"?`,
		},
	}
}

func workbuddyDynamicHeaders() func(context.Context) ([]proxy.ExtraHeader, error) {
	return func(context.Context) ([]proxy.ExtraHeader, error) {
		// A proxy-lifetime conversation id stitches every client, chat, and
		// turn into one server-side Craft session. The subscription then
		// keeps "writing" against accumulated thinking state — the
		// "Let me write." / "OK." collapse. Each OpenAI request already
		// carries its own messages, so a fresh conversation per call is
		// the honest unit.
		conversationID, err := proxy.NewInstanceID()
		if err != nil {
			return nil, err
		}
		messageID, err := proxy.NewInstanceID()
		if err != nil {
			return nil, err
		}
		return []proxy.ExtraHeader{
			{Name: "X-Conversation-ID", Value: conversationID},
			{Name: "X-Conversation-Request-ID", Value: messageID},
			{Name: "X-Conversation-Message-ID", Value: messageID},
			{Name: "X-Request-ID", Value: messageID},
			// Drop, do not set: WorkBuddy's custom-model client already sends
			// craft, and the official CLI default is also craft. The
			// subscription then runs its write-agent ("Let me write." / "OK."
			// / "Writing.") instead of returning OpenAI tool_calls. A raw
			// OpenAI backend ignores this header; CodeBuddy does not.
			{Name: "X-Agent-Intent", Drop: true},
			{Name: "X-IDE-Type", Value: "CLI"},
			{Name: "X-IDE-Name", Value: "CodeBuddy"},
			{Name: "X-IDE-Version", Value: "2.63.2"},
			{Name: "X-Private-Data", Value: "false"},
		}, nil
	}
}

// workbuddySanitizeOpenAIBody is the subscription-channel rewrite: billing
// boilerplate out, and a system message prepended when Claude Code sent
// only user blocks (vendor 11128 otherwise). WorkBuddy's custom-model UI
// sends its local namespace on the wire (custom-local:<id>), but the
// subscription endpoint only accepts the provider's actual model id. Strip
// only that client-owned namespace; every other model id stays untouched.
func workbuddySanitizeOpenAIBody(body []byte) []byte {
	body = protocol.SanitizeOpenAIBody(body)
	var v map[string]interface{}
	if json.Unmarshal(body, &v) != nil {
		return body
	}
	if model, ok := v["model"].(string); ok {
		// The vendor is strict about the slug: " hy3" and "HY3" both
		// answer 11102 service info not found (proxy.log), and slugs are
		// lowercase by contract, so normalise before the prefix strip.
		v["model"] = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), workbuddyCustomLocalModelPrefix)
	}
	// Non-stream chat is a vendor 11101. Borrowing clients that omit
	// stream:true otherwise die before a token is produced.
	if stream, ok := v["stream"].(bool); !ok || !stream {
		v["stream"] = true
	}
	// The vendor's Go struct takes tool_choice as a string. Both the
	// Anthropic translation (a pinned tool becomes an object) and OpenAI
	// clients may send the object form, which the vendor rejects with
	// 11101 "cannot unmarshal object ... of type string" (proxy.log).
	// An object always means a specific tool was requested, which is
	// "required" in string vocabulary; strings pass through untouched.
	if _, ok := v["tool_choice"].(map[string]interface{}); ok {
		v["tool_choice"] = "required"
	}
	msgs, _ := v["messages"].([]interface{})
	for _, raw := range msgs {
		message, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		text := workbuddyMessageText(message["content"])
		// WorkBuddy rejects the long identity/tool preamble emitted by other
		// agent CLIs as an unapproved channel (11128). A short user prompt is
		// user data and must remain byte-for-byte untouched; only system text
		// and the large internal context block are channel metadata here.
		if role != "system" && !(role == "user" && len(text) > 1024) {
			continue
		}
		message["content"] = workbuddySanitizeTextContent(message["content"])
	}
	if !workbuddyHasLeadingSystem(msgs) {
		sys := map[string]interface{}{
			"role":    "system",
			"content": "You are a helpful coding assistant.",
		}
		v["messages"] = append([]interface{}{sys}, msgs...)
	}
	out, err := json.Marshal(v)
	if err != nil {
		return body
	}
	return out
}

func workbuddyMessageText(content interface{}) string {
	if text, ok := content.(string); ok {
		return text
	}
	data, _ := json.Marshal(content)
	return string(data)
}

func workbuddySanitizeTextContent(content interface{}) interface{} {
	sanitize := func(text string) string {
		for _, replacement := range workbuddyBlockedSnippets {
			text = replaceWorkBuddyFold(text, replacement[0], replacement[1])
		}
		return text
	}
	if text, ok := content.(string); ok {
		return sanitize(text)
	}
	blocks, ok := content.([]interface{})
	if !ok {
		return content
	}
	for _, raw := range blocks {
		block, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if typ, _ := block["type"].(string); typ == "text" {
			if text, ok := block["text"].(string); ok {
				block["text"] = sanitize(text)
			}
		}
	}
	return blocks
}

var workbuddyBlockedSnippets = [][2]string{
	{"You are Codex CLI", "You are a coding assistant"},
	{"OpenAI Codex", "the coding assistant"},
	{"Codex CLI", "the coding assistant"},
	{"Claude Code", "the coding assistant"},
	{"Anthropic's official CLI", "the official coding assistant"},
	{"OpenAI", "the AI platform"},
	{"Codex", "the coding assistant"},
	{"MCP", "the tool protocol"},
}

func replaceWorkBuddyFold(text, old, replacement string) string {
	lower, oldLower := strings.ToLower(text), strings.ToLower(old)
	var out strings.Builder
	for {
		index := strings.Index(lower, oldLower)
		if index < 0 {
			out.WriteString(text)
			break
		}
		out.WriteString(text[:index])
		out.WriteString(replacement)
		text = text[index+len(old):]
		lower = lower[index+len(old):]
	}
	return out.String()
}

func workbuddyHasLeadingSystem(msgs []interface{}) bool {
	if len(msgs) == 0 {
		return false
	}
	mm, ok := msgs[0].(map[string]interface{})
	if !ok {
		return false
	}
	role, _ := mm["role"].(string)
	return role == "system"
}
