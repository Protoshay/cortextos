
/**
 * hook-ask-telegram.ts - Non-blocking PreToolUse hook for AskUserQuestion
 * Sends question(s) to Telegram via IPC (daemon-owned token), saves state file, exits immediately.
 * The fast-checker daemon handles responses and navigates multi-question flows.
 */

import { IPCClient } from '../daemon/ipc-server';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  buildAskState,
  buildAskSingleSelectKeyboard,
  buildAskMultiSelectKeyboard,
  formatQuestionMessage,
} from './index';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const questions = tool_input.questions || [];
  if (questions.length === 0) {
    process.exit(0);
  }

  const env = loadEnv();

  if (!env.chatId) {
    process.exit(0);
  }

  // Save state file for fast-checker
  mkdirSync(env.stateDir, { recursive: true });
  const stateFile = join(env.stateDir, 'ask-state.json');
  const state = buildAskState(questions);
  writeFileSync(stateFile, JSON.stringify(state), 'utf-8');

  // Send first question via IPC (daemon-owned token, bypasses semantic checker)
  const q = questions[0];
  const isMultiSelect = q.multiSelect || false;
  const options = (q.options || []).map((o: any) => o.label || o);

  const messageText = formatQuestionMessage(env.agentName, 0, questions.length, q);

  const keyboard = isMultiSelect
    ? buildAskMultiSelectKeyboard(0, options)
    : buildAskSingleSelectKeyboard(0, options);

  try {
    const instanceId = process.env.CTX_INSTANCE_ID || 'default';
    const ipc = new IPCClient(instanceId);
    await ipc.send({
      type: 'send-human-message',
      agent: env.agentName,
      source: 'hook-ask-telegram',
      data: {
        chatId: env.chatId,
        text: messageText,
        replyMarkup: keyboard,
        source: 'hook',
      },
    });
  } catch {
    // Non-blocking — exit even on send failure. The fast-checker poll will
    // surface the state file and the operator will see the next question.
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`hook-ask-telegram error: ${err}\n`);
  process.exit(0);
});
