// multi-dispatch.test.ts — the fan-out half of multi (the normalizer half is multi.test.ts).
// Mocks callGateway so no network/model is touched; asserts each step resolves to the right
// fulfillment and that only home_assistant steps cost a pass-2 call.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { dispatchMultiTurn, recoverHaAction, type MultiDispatchDeps } from './multi-dispatch.ts';
import type { GatewayResult, GatewayRaw } from './io-contracts.ts';
import { parseContent } from './parse.ts';

const HA_ACTION = {
  type: 'action',
  voice: 'Done.',
  action: { category: 'homeassistant', command: 'execute_commands', parameters: { commands: [{ domain: 'light', service: 'turn_on', entity_id: 'light.family_room' }] } },
};

function gwOk(content: string): GatewayResult {
  const raw: GatewayRaw = { content, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, model: 'gemini', provider: 'gemini' };
  return { ok: true, raw, latency_ms: 42 };
}

/** A callGateway spy that returns a fixed HA action and counts calls. */
function haGateway(content = JSON.stringify(HA_ACTION)) {
  let calls = 0;
  const fn = (_args: unknown): Promise<GatewayResult> => {
    calls++;
    return Promise.resolve(gwOk(content));
  };
  return { fn, calls: () => calls };
}

function depsWith(callGateway: MultiDispatchDeps['callGateway'], entities?: MultiDispatchDeps['entities']): MultiDispatchDeps {
  return { callGateway, provider: 'gemini', modelId: 'gemini-2.5-flash', context: {}, userText: 'dim the family room light and play that song', entities };
}

Deno.test('home_assistant + music → HA action (1 pass-2) + music client_tool (0 pass-2)', async () => {
  const gw = haGateway();
  const res = await dispatchMultiTurn(
    [
      { tool: 'home_assistant', query: { command_hint: 'dim the family room light to 30%' } },
      { tool: 'music', query: { action: 'play', query: 'that song' } },
    ],
    depsWith(gw.fn, [{ entity_id: 'light.family_room', domain: 'light' }]),
  );
  assertEquals(gw.calls(), 1); // only the HA step calls the model
  assertEquals(res.steps.length, 2);
  assertEquals(res.steps[0].tool, 'home_assistant');
  assertEquals(res.steps[0].action?.command, 'execute_commands');
  assertEquals(res.steps[0].unsupported_tool, undefined);
  assertEquals(res.steps[1].tool, 'music');
  assertEquals(res.steps[1].client_tool, { tool: 'music', query: { action: 'play', query: 'that song' } });
  assertEquals(res.usage.input_tokens, 10); // one HA pass
  assertEquals(res.stages.length, 1);
});

Deno.test('home_assistant step with NO entities → unsupported, no model call', async () => {
  const gw = haGateway();
  const res = await dispatchMultiTurn(
    [
      { tool: 'home_assistant', query: { command_hint: 'turn off the lights' } },
      { tool: 'music', query: { action: 'play' } },
    ],
    depsWith(gw.fn, []), // no entities supplied
  );
  assertEquals(gw.calls(), 0);
  assertEquals(res.steps[0].unsupported_tool, 'home_assistant');
  assertEquals(res.steps[0].action, undefined);
  assertEquals(res.steps[1].client_tool?.tool, 'music');
});

Deno.test('music + video_feeds → two client_tools, zero model calls', async () => {
  const gw = haGateway();
  const res = await dispatchMultiTurn(
    [
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
      { tool: 'video_feeds', query: { action: 'show', camera: 'front door' } },
    ],
    depsWith(gw.fn),
  );
  assertEquals(gw.calls(), 0);
  assertEquals(res.steps.map((s) => s.tool), ['music', 'video_feeds']);
  assertEquals(res.steps.every((s) => !!s.client_tool), true);
  assertEquals(res.stages.length, 0);
});

Deno.test('mis-enveloped HA pass-2 (info_request with commands) is recovered to an action', async () => {
  // Model re-emits the tool request instead of {type:'action'} — Fix C lifts the commands.
  const misEnveloped = JSON.stringify({
    type: 'info_request', tool: 'home_assistant', voice: 'Dimming',
    query: { commands: [{ domain: 'light', service: 'turn_on', entity_id: 'light.family_room', brightness_pct: 30 }] },
  });
  const gw = haGateway(misEnveloped);
  const res = await dispatchMultiTurn(
    [
      { tool: 'home_assistant', query: { command_hint: 'dim to 30%' } },
      { tool: 'music', query: { action: 'play' } },
    ],
    depsWith(gw.fn, [{ entity_id: 'light.family_room', domain: 'light' }]),
  );
  assertEquals(res.steps[0].action?.command, 'execute_commands');
  assertEquals(res.steps[0].unsupported_tool, undefined);
});

Deno.test('recoverHaAction: null when no domain+service commands present', () => {
  const parsed = parseContent(JSON.stringify({ type: 'info_request', tool: 'home_assistant', query: { commands: [{ foo: 'bar' }] } }));
  assertEquals(recoverHaAction(parsed!), null);
});
