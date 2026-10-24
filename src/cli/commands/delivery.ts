import { createDeliveryTest, testStatus, type TestSenders, type TestStatus } from '../../events/delivery-test.js';
import { postWebhook, runHook } from '../../events/dispatch.js';
import { CliExit, type CliContext } from '../context.js';

export interface DeliveryTestStarted {
  test_id: string;
  agent: string;
  transport: TestStatus['transport'];
  signed: boolean | null;
  next_steps: string[];
}

/** 建立測試事件，經已啟用的通道送出，回傳 test_id 與 agent 接下來要做的步驟。 */
export async function deliveryTestCommand(
  ctx: CliContext,
  o: { agent: string },
  senders: TestSenders = {},
): Promise<DeliveryTestStarted> {
  let id: string;
  try {
    const r = await createDeliveryTest(ctx.outbox.outboxDir, o.agent, ctx.config.delivery, ctx.now(), {
      runHook: senders.runHook ?? ((c, e) => runHook(c, e, undefined, 'test')),
      postWebhook:
        senders.postWebhook ??
        ((u, e, secret) => postWebhook(u, e, fetch, undefined, { secret, kind: 'test' })),
    });
    id = r.test_id;
  } catch (e) {
    throw new CliExit(1, e instanceof Error ? e.message : String(e));
  }
  const st = testStatus(ctx.outbox.outboxDir, id, ctx.now());
  return {
    test_id: id,
    agent: o.agent,
    transport: st.transport,
    signed: st.signed,
    next_steps: [
      `ilearn events --deliverable --agent ${o.agent} --test --json`,
      `ilearn events report ${o.agent} ${id} --status processed --test`,
      `ilearn events ack ${o.agent} ${id} --test`,
      `ilearn delivery test --status ${id}`,
    ],
  };
}

export function deliveryTestStatusCommand(ctx: CliContext, testId: string): TestStatus {
  try {
    return testStatus(ctx.outbox.outboxDir, testId, ctx.now());
  } catch (e) {
    throw new CliExit(1, e instanceof Error ? e.message : String(e));
  }
}
