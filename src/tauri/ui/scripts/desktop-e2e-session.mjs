export async function createNativeSession(request, wait, capabilities) {
  // HTTP 200 only means the embedded server is listening. WebView2 can still
  // be starting; creating a session then exhausts the driver's shorter wait.
  await wait('native WebDriver ready', async () => (await request('GET', '/status'))?.ready === true);
  return request('POST', '/session', { capabilities: { alwaysMatch: capabilities } });
}
