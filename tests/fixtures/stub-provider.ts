// Test-only provider: a scripted model with no network. STUB_SCRIPT names a module whose default
// export maps (transcript messages, call number) to {text, thinking?} or {tool, args}.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default (pi: ExtensionAPI) => register(pi, "stub");

export async function register(pi: ExtensionAPI, provider: string) {
  const script = (await import(process.env.STUB_SCRIPT!)).default;
  const f = fauxProvider({ provider, api: provider, models: [{ id: "script" }] });
  const step = (ctx: any, _o: any, state: any) => {
    const s = script(ctx.messages, state.callCount, ctx);
    return fauxAssistantMessage(s.tool ? fauxToolCall(s.tool, s.args) : [...(s.thinking ? [fauxThinking(s.thinking)] : []), fauxText(s.text)], { stopReason: s.tool ? "toolUse" : "stop" });
  };
  f.setResponses(Array.from({ length: 64 }, () => step));
  for (const m of f.models) (m as any).baseUrl = "https://stub.invalid/v1";
  pi.registerProvider({ ...f.provider, baseUrl: "https://stub.invalid/v1" });
}
