/**
 * Context supplied by CLI config loading when normalizing prompt-generator
 * specs that came from a JSON config file.
 */
export interface PromptGeneratorConfigContext {
  /**
   * Directory containing the config file.
   */
  readonly configDir: string;
}

/**
 * Check whether an unknown value is a plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Assert that an object contains only known properties.
 */
export function assertKnownProperties(
  value: Record<string, unknown>,
  knownProperties: ReadonlyArray<string>,
  prefix: string,
): void {
  for (const key of Object.keys(value)) {
    if (!knownProperties.includes(key)) {
      throw new Error(`${prefix}.${key} is not supported`);
    }
  }
}

/**
 * Assert that an optional object property is a boolean.
 */
export function assertOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (key in value && typeof value[key] !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
}

/**
 * Assert that an optional object property is a string.
 */
export function assertOptionalString(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (key in value && typeof value[key] !== 'string') {
    throw new Error(`${field} must be a string`);
  }
}

/**
 * Assert that an object property is a required string.
 */
export function assertRequiredString(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (!(key in value) || typeof value[key] !== 'string') {
    throw new Error(`${field} must be a string`);
  }
}

/**
 * Assert that an optional object property is an array of strings.
 */
export function assertOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (!(key in value)) {
    return;
  }

  const array = value[key];
  // istanbul ignore else
  if (!Array.isArray(array) || array.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
}
