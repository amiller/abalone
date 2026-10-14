// This integration uses encrypted message text for tools, not native API fields.
// Keep request and reply enforcement identical across ordinary and coupon routes.
export function prepareNearTextTools(body) {
  if (!Array.isArray(body.messages) || body.messages.some((message) => !message ||
    ["tool", "function"].includes(message.role) ||
    ["tool_calls", "function_call", "tool_call_id", "name"].some((field) => Object.hasOwn(message, field)))) {
    throw new Error("Stopped. Native tool history is unsupported by this NEAR integration; use tools inside encrypted message text.");
  }
  for (const field of ["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"]) delete body[field];
}

export function assertNearTextToolReply(value) {
  for (const choice of value.choices ?? []) {
    if (["tool_calls", "function_call"].includes(choice.finish_reason) ||
      [choice.delta, choice.message].some((message) => message &&
        ["tool_calls", "function_call", "nearai_tool_result"].some((field) => message[field] != null))) {
      throw new Error("Stopped. NEAR returned an unsupported native tool response; no tool from that response will run.");
    }
  }
}
