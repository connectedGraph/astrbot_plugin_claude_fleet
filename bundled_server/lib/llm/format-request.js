// Anthropic /v1/messages 请求体 → OpenAI /chat/completions 请求体转换。
// 核心逻辑取自 y-router (MIT, luohy15/y-router) formatRequest.ts，二改：
//  - 去掉 model 名到 openrouter 风格的映射（代理层已统一覆盖真实 model）
//  - 剥离 Anthropic 专属的 cache_control / thinking 块（OpenAI 兼容供应商大多不认，会 400）
//  - system 多条合并为一条纯文本（部分 OpenAI 兼容供应商只认一条 system）
//  - 保留 tool_use↔tool_calls、tool_result↔role:tool 的配对转换
// 无运行时依赖，纯函数。

function stripBlockMeta(part) {
  // 去掉 Anthropic content block 上的 cache_control 等元数据，保留正文。
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const { cache_control, ...rest } = part;
    return rest;
  }
  return part;
}

function openAiMessagesFromAnthropic(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const out = [];

  for (const msg of messages) {
    // content 是字符串（简单消息）
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      out.push({ role: msg.role, content: msg.content ?? '' });
      continue;
    }

    if (msg.role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const part of msg.content) {
        const block = stripBlockMeta(part);
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          text += (typeof block.text === 'string' ? block.text : JSON.stringify(block.text)) + '\n';
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
        // thinking / redacted_thinking：OpenAI 无对应概念，忽略
      }
      const assistant = { role: 'assistant', content: text.trim() || null };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      out.push(assistant);
    } else if (msg.role === 'user') {
      let text = '';
      const toolResults = [];
      for (const part of msg.content) {
        const block = stripBlockMeta(part);
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          text += (typeof block.text === 'string' ? block.text : JSON.stringify(block.text)) + '\n';
        } else if (block.type === 'image') {
          text += '[图片]\n';
        } else if (block.type === 'tool_result') {
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        }
      }
      if (text.trim()) out.push({ role: 'user', content: text.trim() });
      out.push(...toolResults);
    } else {
      out.push({ role: msg.role, content: msg.content });
    }
  }

  return validateOpenAIToolCalls(out);
}

// OpenAI 要求 role:tool 消息紧跟在带 tool_calls 的 assistant 消息之后；
// 防御性校验，剔除不成对的孤儿 tool 消息。
function validateOpenAIToolCalls(messages) {
  const validated = [];
  const acceptedToolCallIds = new Set();

  for (let i = 0; i < messages.length; i++) {
    const current = { ...messages[i] };

    if (current.role === 'assistant' && Array.isArray(current.tool_calls)) {
      const kept = current.tool_calls.filter((call) => call?.id);
      if (kept.length) {
        for (const call of kept) acceptedToolCallIds.add(call.id);
        current.tool_calls = kept;
      } else {
        delete current.tool_calls;
      }
      if (current.content || current.tool_calls) validated.push(current);
      continue;
    }

    if (current.role === 'tool') {
      if (current.tool_call_id && acceptedToolCallIds.has(current.tool_call_id)) {
        validated.push(current);
      }
      continue;
    }

    validated.push(current);
  }

  return validated;
}

function openAiSystem(body) {
  const system = body.system;
  const blocks = Array.isArray(system)
    ? system
    : typeof system === 'string' && system
      ? [{ type: 'text', text: system }]
      : [];
  const texts = blocks
    .filter((block) => block && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : JSON.stringify(block.text)))
    .filter(Boolean);
  if (!texts.length) return [];
  return [{ role: 'system', content: texts.join('\n\n') }];
}

function openAiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * 把 Anthropic 请求体转为 OpenAI 请求体。
 * @param {object} body Anthropic /v1/messages 请求体
 * @param {{model?: string}} overrides 可选的 model 覆盖（由代理层传入真实上游模型名）
 */
export function formatAnthropicToOpenAI(body, overrides = {}) {
  const data = {
    model: overrides.model || body.model,
    messages: [...openAiSystem(body), ...openAiMessagesFromAnthropic(body)],
  };

  if (body.temperature !== undefined) data.temperature = body.temperature;
  if (body.max_tokens !== undefined) data.max_tokens = body.max_tokens;
  if (body.stream !== undefined) data.stream = body.stream;
  if (body.top_p !== undefined) data.top_p = body.top_p;

  const tools = openAiTools(body.tools);
  if (tools) data.tools = tools;

  return data;
}
