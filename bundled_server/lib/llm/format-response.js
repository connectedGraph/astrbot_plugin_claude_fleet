// OpenAI /chat/completions 非流式响应 → Anthropic /v1/messages 响应转换。
// 取自 y-router (MIT) formatResponse.ts，二改：
//  - 支持 text 与 tool_calls 同时存在
//  - 透传真实 usage，映射 finish_reason → stop_reason

function parseArguments(raw) {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // 截断/异常时保留原始片段，避免转换层抛错导致整次请求失败
    return { raw };
  }
}

/**
 * 把 OpenAI 非流式完成对象还原为 Anthropic 消息。
 * @param {object} completion OpenAI /chat/completions 响应体
 * @param {string} model 回显给 Anthropic 的模型名
 */
export function formatOpenAIToAnthropic(completion, model) {
  const choice = completion?.choices?.[0];
  const message = choice?.message || {};
  const content = [];

  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function?.name,
      input: parseArguments(toolCall.function?.arguments),
    });
  }

  const finish = choice?.finish_reason;
  const stopReason = finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  const usage = completion?.usage;

  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage
      ? {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}
