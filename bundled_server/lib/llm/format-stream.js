// OpenAI /chat/completions SSE 流 → Anthropic /v1/messages SSE 事件流合成。
// 核心思路取自 y-router (MIT) streamResponse.ts，二改：
//  - 修 content_block index：y-router 首块从 1 开始，Anthropic 要求从 0 连续递增
//  - usage 从 OpenAI 流的 usage 字段透传，不再硬编码假值
//  - 输出标准 SSE 事件序列：message_start → content_block_start/delta/stop → message_delta → message_stop
// 无运行时依赖，纯函数。

function nextMessageId() {
  let seq = 0;
  return () => `msg_${Date.now()}_${seq++}`;
}

/**
 * 把 OpenAI 的流式响应体合成 Anthropic SSE 事件流。
 * @param {ReadableStream} openaiStream 上游 /chat/completions 的流式 body
 * @param {string} model 回显给 Anthropic 的模型名
 */
export function streamOpenAIToAnthropic(openaiStream, model) {
  const newId = nextMessageId();
  const messageId = newId();
  const encoder = new TextEncoder();

  const enqueueSSE = (controller, eventType, data) => {
    controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  return new ReadableStream({
    async start(controller) {
      let usage = { input_tokens: 0, output_tokens: 0 };

      // message_start
      enqueueSSE(controller, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      });

      // 内容块状态机
      let contentBlockIndex = 0; // Anthropic 要求从 0 连续递增
      let openBlock = null; // null | 'text' | 'tool'
      let currentToolCallId = null;
      let currentToolName = null;
      let lastBlockWasTool = false;
      const toolJson = new Map();

      const closeBlock = () => {
        if (!openBlock) return;
        if (openBlock === 'tool') lastBlockWasTool = true;
        enqueueSSE(controller, 'content_block_stop', {
          type: 'content_block_stop',
          index: contentBlockIndex,
        });
        openBlock = null;
        contentBlockIndex++;
      };

      const startTextBlock = () => {
        if (openBlock === 'text') return;
        closeBlock();
        enqueueSSE(controller, 'content_block_start', {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'text', text: '' },
        });
        openBlock = 'text';
      };

      const startToolBlock = (id, name) => {
        if (openBlock === 'tool' && currentToolCallId === id) return;
        closeBlock();
        currentToolCallId = id;
        currentToolName = name;
        toolJson.set(id, '');
        enqueueSSE(controller, 'content_block_start', {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        });
        openBlock = 'tool';
      };

      const emitText = (text) => {
        startTextBlock();
        enqueueSSE(controller, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'text_delta', text },
        });
      };

      const emitToolArgs = (id, argsFragment) => {
        startToolBlock(id, currentToolName);
        const accumulated = (toolJson.get(id) || '') + argsFragment;
        toolJson.set(id, accumulated);
        enqueueSSE(controller, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'input_json_delta', partial_json: argsFragment },
        });
      };

      const processDelta = (delta) => {
        // OpenAI 流式 tool_calls：第一块带 id+name，后续块带 function.arguments 增量（无 id）
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          for (const toolCall of delta.tool_calls) {
            const id = toolCall.id;
            if (id) {
              const name = toolCall.function?.name;
              startToolBlock(id, name);
            } else if (currentToolCallId && toolCall.function?.arguments) {
              emitToolArgs(currentToolCallId, toolCall.function.arguments);
            }
          }
          return;
        }
        if (typeof delta.content === 'string' && delta.content) {
          emitText(delta.content);
        }
      };

      const reader = openaiStream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }
        // usage 通常在流末尾的独立 chunk（choices 为空）
        if (parsed.usage) {
          usage = {
            input_tokens: parsed.usage.prompt_tokens ?? usage.input_tokens,
            output_tokens: parsed.usage.completion_tokens ?? usage.output_tokens,
          };
        }
        const delta = parsed.choices?.[0]?.delta;
        if (delta) processDelta(delta);
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) handleLine(line);
        }
        if (buffer.trim()) handleLine(buffer);
      } finally {
        reader.releaseLock();
      }

      closeBlock();
      const stopReason = lastBlockWasTool ? 'tool_use' : 'end_turn';

      enqueueSSE(controller, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage,
      });
      enqueueSSE(controller, 'message_stop', { type: 'message_stop' });
      controller.close();
    },
  });
}
