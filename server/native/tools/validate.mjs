// Проверка аргументов вызова инструмента по его inputSchema ДО выполнения.
//
// Модель может прислать синтаксически верный JSON без обязательного поля
// (например, write без content). Раньше такой вызов доходил до обработчика,
// и write обнулял файл. Здесь вызов отклоняется с понятной ошибкой, по
// которой модель может исправить аргументы.
//
// Проверка намеренно мягкая к безобидным отклонениям: лишние поля не
// считаются ошибкой, числа и булевы значения строкой ("5", "true")
// приводятся к нужному типу.

const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

function coerce(schema, value) {
  const type = schema?.type;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((type === 'integer' || type === 'number') && trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
    if (type === 'boolean' && /^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
    if ((type === 'array' || type === 'object') && /^[[{]/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeName(parsed) === type) return parsed;
      } catch {}
    }
  }
  return value;
}

function check(schema, input, at, errors) {
  if (!schema || typeof schema !== 'object') return input;
  const value = coerce(schema, input);
  const type = schema.type;
  const actual = typeName(value);
  const label = at || 'arguments';
  if (type) {
    const ok =
      type === 'integer'
        ? Number.isInteger(value)
        : type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : actual === type;
    if (!ok) {
      errors.push(`${label}: expected ${type}, got ${actual}`);
      return value;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${label}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${label}: must be >= ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${label}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength)
      errors.push(`${label}: must be at least ${schema.minLength} characters`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength)
      errors.push(`${label}: must be at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems)
      errors.push(`${label}: needs at least ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems)
      errors.push(`${label}: allows at most ${schema.maxItems} items`);
    if (schema.items) return value.map((item, i) => check(schema.items, item, `${label}[${i}]`, errors));
  }
  if (actual === 'object' && (schema.properties || schema.required)) {
    const out = { ...value };
    for (const key of schema.required || []) {
      if (out[key] === undefined || out[key] === null) errors.push(`${at ? `${at}.` : ''}${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (out[key] === undefined || out[key] === null) continue;
      out[key] = check(sub, out[key], at ? `${at}.${key}` : key, errors);
    }
    return out;
  }
  return value;
}

/** Returns { ok, value, errors }. value has lenient coercions applied. */
export function validateToolInput(schema, input) {
  const errors = [];
  const value = check(schema || { type: 'object' }, input ?? {}, '', errors);
  return { ok: errors.length === 0, value, errors };
}

export class ToolArgumentsError extends Error {
  constructor(tool, errors, schema) {
    const params = Object.entries(schema?.properties || {})
      .map(([k, s]) => `${k}${(schema.required || []).includes(k) ? ' (required)' : ''}: ${s?.type || 'any'}`)
      .join('; ');
    super(
      `Invalid arguments for ${tool}: ${errors.slice(0, 8).join('; ')}. Nothing was executed. Expected parameters: ${params}. Fix the arguments and call ${tool} again.`,
    );
    this.name = 'ToolArgumentsError';
    this.code = 'INVALID_TOOL_ARGUMENTS';
    this.errors = errors;
  }
}
