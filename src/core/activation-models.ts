import type { BindingSpec, ModelSelection } from '../types';

/** Merge model roles into client options and seed default from an explicit model. */
export function mergeModelRolesIntoClientOptions(
  base: Record<string, unknown> | undefined,
  modelRoles: Record<string, string> | undefined,
  model: ModelSelection,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const roles: Record<string, string> = {};
  const existing = out.modelRoles;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [key, value] of Object.entries(existing as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) {
        roles[key] = value.trim();
      }
    }
  }
  if (modelRoles) {
    for (const [key, value] of Object.entries(modelRoles)) {
      if (typeof value === 'string' && value.trim()) {
        roles[key] = value.trim();
      }
    }
  }
  if (model.mode === 'explicit' && model.id && !roles.default) {
    roles.default = model.id;
  }
  if (Object.keys(roles).length > 0) {
    out.modelRoles = roles;
  }
  return out;
}

/** Prefer clientOptions.modelRoles.default when model selection is omitted. */
export function modelFromRolesOrSelection(
  bindingSpec: BindingSpec,
  model: ModelSelection,
): ModelSelection {
  if (model.mode === 'explicit') {
    return model;
  }
  const roles = bindingSpec.clientOptions?.modelRoles;
  if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
    const defaultModel = (roles as Record<string, unknown>).default;
    if (typeof defaultModel === 'string' && defaultModel.trim()) {
      return { mode: 'explicit', id: defaultModel.trim() };
    }
  }
  return model;
}
