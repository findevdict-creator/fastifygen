import type { JsonSchemaNode } from '../api/types.js';
import { Labels } from '../lib/ConfigPath.js';

interface SchemaFieldProps {
  name: string;
  schema: JsonSchemaNode;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Rendered `id` prefix, so labels point at their inputs. */
  idPrefix: string;
}

/** One config setting, rendered from its JSON Schema: a toggle, a select, a number, a list or text. */
export function SchemaField({ name, schema, value, onChange, idPrefix }: SchemaFieldProps) {
  const id = `${idPrefix}-${name}`;
  const label = schema.title ?? Labels.humanize(name);
  const hint = schema.description;
  const fallback = schema.default;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === 'boolean') {
    const checked = typeof value === 'boolean' ? value : fallback === true;
    return (
      <div className="field">
        <span className="label">{label}</span>
        <label className="toggle" htmlFor={id}>
          <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
          <span>{checked ? 'On' : 'Off'}</span>
          {value === undefined && fallback !== undefined && <span className="default-tag">default</span>}
        </label>
        {hint && <span className="hint">{hint}</span>}
      </div>
    );
  }

  if (schema.enum) {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <select id={id} className="input" value={String(value ?? fallback ?? '')} onChange={(event) => onChange(event.target.value)}>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
              {option === fallback ? ' (default)' : ''}
            </option>
          ))}
        </select>
        {hint && <span className="hint">{hint}</span>}
      </div>
    );
  }

  if (type === 'array' && schema.items?.enum) {
    const selected = Array.isArray(value) ? (value as string[]) : ((fallback as string[] | undefined) ?? []);
    const options = schema.items.enum.map(String);
    return (
      <fieldset className="field wide" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ padding: 0, marginBottom: 5 }}>{label}</legend>
        <div className="checks">
          {options.map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                id={`${id}-${option}`}
                checked={selected.includes(option)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? options.filter((o) => o === option || selected.includes(o))
                      : selected.filter((o) => o !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
        </div>
        {hint && <span className="hint">{hint}</span>}
      </fieldset>
    );
  }

  if (type === 'array') {
    const list = Array.isArray(value) ? (value as string[]) : undefined;
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className="input mono"
          value={list?.join(', ') ?? ''}
          placeholder={Array.isArray(fallback) ? fallback.join(', ') : ''}
          onChange={(event) => {
            const items = event.target.value.split(',').map((item) => item.trim());
            onChange(event.target.value.trim() === '' ? undefined : items);
          }}
          onBlur={() => list && onChange(list.filter(Boolean).length ? list.filter(Boolean) : undefined)}
        />
        {hint && <span className="hint">{hint} Separate entries with commas.</span>}
      </div>
    );
  }

  if (type === 'integer' || type === 'number') {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className="input"
          type="number"
          inputMode="numeric"
          min={schema.minimum}
          max={schema.maximum}
          value={typeof value === 'number' ? value : ''}
          placeholder={fallback === undefined ? '' : String(fallback)}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
        {hint && <span className="hint">{hint}</span>}
      </div>
    );
  }

  const secret = name === 'password';
  return (
    <div className={`field${name === 'url' ? ' wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input mono"
        type={secret && !String(value ?? '').startsWith('${') ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={typeof value === 'string' ? value : ''}
        placeholder={fallback === undefined ? '' : String(fallback)}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
