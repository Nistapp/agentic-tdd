import type { IEventBus } from '../core/interfaces.js';
import type { AgenticEvent } from '../core/types.js';
import { PipelinePass, PASS_LABELS, AGENT_NAMES } from '../core/types.js';

import { TerminalRenderer } from './terminal-renderer.js';
import { loggers } from '../utils/logger.js';

export function attachTerminalListener(
  events: IEventBus,
  renderer: TerminalRenderer,
  version: string,
): void {

  events.on('PIPELINE_STARTED', (evt: AgenticEvent) => {
    loggers.core.info(`PIPELINE_STARTED: ${evt.message}`);
  });

  events.on('PASS_STARTED', (evt: AgenticEvent) => {
    const p = evt.pass ?? 0;
    const label     = PASS_LABELS[p]  ?? '';
    const agentName = AGENT_NAMES[p]  ?? '';
    renderer.passHeader(`Pass ${p} — ${label}  [${agentName}]`);
  });

  events.on('PASS_COMPLETED', (evt: AgenticEvent) => {
    const label = evt.pass !== undefined ? (PASS_LABELS[evt.pass] ?? '') : '';
    renderer.passOk(`Pass ${evt.pass} — ${label}`);

    if (evt.payload) {
      if (evt.payload.attempts !== undefined) {
        renderer.logAttemptCount(evt.payload.attempts as number);
      }
      const files = evt.payload.files as
        ReadonlyArray<{ status: string; file: string }> | undefined;
      if (files && files.length > 0) {
        renderer.logChangedFiles(files);
      } else if (
        evt.pass !== undefined &&
        evt.pass >= PipelinePass.Refactor &&
        evt.pass <= PipelinePass.Security
      ) {
        renderer.logNoChanges();
      }
    }
  });

  events.on('TEST_RUN_STARTED',   (evt: AgenticEvent) => renderer.logTestStatus(evt.message));
  events.on('TEST_RUN_COMPLETED', (evt: AgenticEvent) => renderer.logTestStatus(evt.message));
  events.on('TEST_RUN_FAILED',    (evt: AgenticEvent) => renderer.logTestStatus(evt.message));

  events.on('SELF_CORRECTION_ATTEMPTED', (evt: AgenticEvent) =>
    renderer.logCompaction(evt.message),
  );

  events.on('WARNING', (evt: AgenticEvent) => renderer.logWarnMessage(evt.message));
  events.on('ERROR',   (evt: AgenticEvent) => renderer.logErrorMessage(evt.message));

  events.on('PIPELINE_COMPLETED', (_: AgenticEvent) =>
    renderer.logPipelineComplete(version),
  );
}
