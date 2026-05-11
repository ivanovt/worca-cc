const DEFAULT_MODELS = ['opus', 'sonnet', 'haiku'];

export function deriveValidModels(worcaObj) {
  const configuredModels =
    worcaObj?.models &&
    typeof worcaObj.models === 'object' &&
    !Array.isArray(worcaObj.models)
      ? Object.keys(worcaObj.models)
      : [];
  return [...new Set([...DEFAULT_MODELS, ...configuredModels])];
}

export { DEFAULT_MODELS };
