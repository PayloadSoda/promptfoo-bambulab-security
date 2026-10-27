// bambuProvider.js
// Promptfoo custom provider for Bambu Lab live customer-service chatbot.
// Handles single-turn and multi-turn (stateful) testing.
//
// Session model:
//   - Each test case gets a stable sessionId + uuid pair.
//   - Multi-turn strategies reuse the same pair across turns so the
//     chatbot sees a continuous conversation.
//   - The response returns `sessionId` so Promptfoo can propagate it to
//     subsequent turns via `context.vars.sessionId`.
//   - getSessionId() lets Promptfoo's session-aware strategies query the
//     current session.

const crypto = require('crypto');
const { ProxyAgent, fetch } = require('undici');

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY;
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const SSE_CONNECT_TIMEOUT = 15000;
const CHAT_POST_TIMEOUT = 15000;
const TOTAL_STREAM_TIMEOUT = 600000;

// Per-test-case session cache.
// Key: stable conversation identifier derived from Promptfoo context.
// Value: { sessionId, uuid, cacheKey }
const sessionCache = new Map();

/**
 * Derive a stable conversation key from the Promptfoo context.
 *
 * Verified context shape (Promptfoo >= 0.115):
 *   context.evaluationId             -> "eval-XXX" (stable for whole run)
 *   context.testIdx                  -> 0, 1, 2, ... (unique per test case)
 *   context.test.metadata.goal       -> unique per generated test case
 *   context.vars.sessionId           -> propagated by Promptfoo on turn 2+
 *   context.vars.__evalId            -> same as evaluationId
 *   context.vars.__evalStepId        -> per-step id (NOT stable across turns)
 *
 * The key must be STABLE across turns of the same test case and UNIQUE
 * across different test cases.
 */
function getConversationKey(context, prompt) {
  // Best: (evaluationId, testIdx) is a globally unique, stable pair.
  const evalId = context?.evaluationId || context?.vars?.__evalId;
  const testIdx = context?.testIdx;
  if (evalId !== undefined && testIdx !== undefined) {
    return `conv:${evalId}:${testIdx}`;
  }

  // Next best: the generated test case's goal string is unique and stable.
  const goal = context?.test?.metadata?.goal;
  if (goal) {
    return `conv:goal:${goal}`;
  }

  // Secondary fallbacks (may be populated by different Promptfoo versions).
  const candidates = [
    context?.test?.id,
    context?.test?.vars?.testcaseId,
    context?.test?.vars?.conversationId,
    context?.test?.metadata?.testcaseId,
    context?.test?.metadata?.conversationId,
    context?.test?.metadata?.sessionId,
    context?.vars?.testcaseId,
    context?.vars?.conversationId,
    context?.metadata?.testcaseId,
    context?.metadata?.conversationId,
    context?.metadata?.sessionId,
    context?.sessionId,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') {
      return `conv:${String(c)}`;
    }
  }

  // Last resort. Works for single-turn, breaks multi-turn.
  console.error(
    '[Bambu] ⚠ No stable conversation key found in context. ' +
      'Falling back to prompt-based key. Multi-turn may not persist.'
  );
  return `prompt:${prompt}`;
}

/**
 * Get or create a session for the given conversation key.
 *
 * If Promptfoo propagated a sessionId from a previous turn
 * (context.vars.sessionId), prefer it so the same server-side Bambu
 * session is reused. Otherwise generate a fresh pair.
 */
function getOrCreateSession(cacheKey, incomingSessionId) {
  let session = sessionCache.get(cacheKey);
  if (!session) {
    session = {
      sessionId: incomingSessionId || crypto.randomUUID(),
      uuid: crypto.randomUUID(),
      cacheKey,
      turn: 0,
      isNew: true,
    };
    sessionCache.set(cacheKey, session);
  }
  session.turn += 1;
  return session;
}

module.exports = class BambuProvider {
  constructor(options) {
    this.providerId = options.id || 'bambu-customer-service';
    this.config = options.config || {};
    this._lastSessionId = null;
  }

  id() {
    return this.providerId;
  }

  /**
   * Promptfoo calls this to get the current session ID for session-aware
   * strategies (Hydra, Crescendo, GOAT, etc.).
   */
  getSessionId() {
    return this._lastSessionId;
  }

  async cleanup() {
    // No-op. The cache is bounded by the number of test cases in the eval.
  }

  async callApi(prompt, context, options) {
    // ---------------------------------------------------------------
    // 1. Session resolution
    // ---------------------------------------------------------------
    const cacheKey = getConversationKey(context, prompt);

    // Promptfoo propagates the previous turn's sessionId via
    // context.vars.sessionId when stateful: true.
    const incomingSessionId = context?.vars?.sessionId;

    const session = getOrCreateSession(cacheKey, incomingSessionId);
    const { sessionId, uuid } = session;
    this._lastSessionId = sessionId;

    console.error(
      `[Bambu] ▶ turn=${session.turn} ${session.isNew ? 'NEW' : 'CONT'} | ` +
        `key=${cacheKey.substring(0, 60)} | session=${sessionId}`
    );
    session.isNew = false;

    // ---------------------------------------------------------------
    // 2. Timeout controller for the whole streaming operation
    // ---------------------------------------------------------------
    const sseController = new AbortController();
    const totalTimeout = setTimeout(() => {
      console.error(`[Bambu] ⏰ Total timeout (${TOTAL_STREAM_TIMEOUT}ms).`);
      sseController.abort();
    }, TOTAL_STREAM_TIMEOUT);

    try {
      // -------------------------------------------------------------
      // 3. SSE connect
      // -------------------------------------------------------------
      const sseUrl = `${this.config.baseUrl}/gw/robot/sse/connect`;
      const sseResponse = await fetch(sseUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'X-Accel-Buffering': 'no',
          Origin: this.config.origin,
          Referer: `${this.config.origin}/liveChat`,
          'User-Agent': this.config.userAgent,
          'x-robot-user': uuid,
          'x-bbl-official-site-region': 'EN',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          ...(this.config.headers || {}),
        },
        signal: sseController.signal,
        dispatcher: proxyAgent,
      });

      if (!sseResponse.ok) {
        clearTimeout(totalTimeout);
        sseController.abort();
        return {
          error: `SSE connection failed: ${sseResponse.status} ${sseResponse.statusText}`,
        };
      }

      const streamPromise = this._readSSEStream(
        sseResponse.body,
        uuid,
        totalTimeout
      );

      await new Promise((r) => setTimeout(r, 200));

      // -------------------------------------------------------------
      // 4. POST /chat
      // -------------------------------------------------------------
      const chatUrl = `${this.config.baseUrl}/gw/robot/sse/chat`;
      const chatPayload = {
        requestId: `clientID_text_${crypto.randomUUID()}`,
        history: [],
        chatbot: [],
        origin: 1,
        cacheFlag: false,
        input: prompt,
        machineModel: '',
        sessionId,
        uuid,
      };

      const chatResponse = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: this.config.origin,
          Referer: `${this.config.origin}/liveChat`,
          'User-Agent': this.config.userAgent,
          'x-robot-user': uuid,
          'x-bbl-official-site-region': 'EN',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          ...(this.config.headers || {}),
        },
        body: JSON.stringify(chatPayload),
        signal: AbortSignal.timeout(CHAT_POST_TIMEOUT),
        dispatcher: proxyAgent,
      });

      if (!chatResponse.ok) {
        clearTimeout(totalTimeout);
        sseController.abort();
        return {
          error: `Chat POST failed: ${chatResponse.status} ${chatResponse.statusText}`,
        };
      }

      // -------------------------------------------------------------
      // 5. Await the streamed response
      // -------------------------------------------------------------
      const fullResponse = await streamPromise;
      clearTimeout(totalTimeout);
      sseController.abort();

      if (fullResponse === null) {
        return {
          error: `Stream timeout after ${TOTAL_STREAM_TIMEOUT}ms (no complete response).`,
          sessionId,
        };
      }

      // -------------------------------------------------------------
      // 6. Return in Promptfoo's expected shape.
      //    sessionId is returned so Promptfoo can propagate it to the
      //    next turn via context.vars.sessionId.
      // -------------------------------------------------------------
      return { output: fullResponse, sessionId };
    } catch (error) {
      clearTimeout(totalTimeout);
      sseController.abort();
      console.error(`[Bambu] ❌ ${error.name} - ${error.message}`);

      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return { error: `Timeout/Abort: ${error.message}`, sessionId };
      }
      return { error: error.message, sessionId };
    }
  }

  async _readSSEStream(body, uuid, totalTimeout) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let eventCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop();

        for (const part of parts) {
          const lines = part.split(/\r?\n|\r/);
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;

            const dataStr = line.substring(5).replace(/^\s/, '');

            if (dataStr === '[DONE]') {
              return fullResponse;
            }

            eventCount++;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.uuid === uuid && parsed.delta) {
                fullResponse += parsed.delta.replace(/<br\s*\/?>/gi, '\n');
              }
            } catch (e) {
              // Ignore non-JSON data lines (heartbeats, comments).
            }
          }
        }
      }

      if (fullResponse.length > 0) return fullResponse;
      return null;
    } catch (err) {
      if (err.name === 'AbortError') {
        if (fullResponse.length > 0) return fullResponse;
        return null;
      }
      throw err;
    }
  }
};