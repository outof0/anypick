import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { HotplugApp } from '../core/app';

export async function wizardViewDetails(app: HotplugApp): Promise<void> {
  const rows = app.bindingService.current();
  const lines: string[] = [];
  for (const r of rows) {
    if (!r.binding) {
      lines.push(`${r.clientName.padEnd(8)} — no binding`);
      continue;
    }
    const src =
      r.binding.spec.source.kind === 'account'
        ? `${r.binding.spec.source.provider}/${r.binding.spec.source.name}`
        : r.binding.spec.source.kind === 'gateway'
          ? r.binding.spec.source.name
          : '?';
    const model =
      r.binding.spec.model.mode === 'explicit'
        ? r.binding.spec.model.id
        : r.binding.spec.model.mode;
    lines.push(`${r.clientName.padEnd(8)} ${src}  (${r.scope}, model ${model})`);
  }
  p.note(lines.join('\n') || 'No clients', 'details');
}

export async function wizardDoctor(app: HotplugApp): Promise<void> {
  const spinner = p.spinner();
  spinner.start('Checking…');
  const report = await app.doctor.run();
  spinner.stop(report.ok ? 'All checks passed' : 'Issues found');
  for (const check of report.checks) {
    if (check.ok) {
      p.log.step(check.message);
    } else {
      p.log.error(check.message);
    }
  }
  if (!report.ok) {
    p.log.message(pc.dim('Fix safe issues: hotplug doctor --fix -y'));
  }
}
