import { Transform } from 'class-transformer';

/** Preserve explicit query booleans before implicit conversion makes "false" truthy. */
export function QueryBoolean(): PropertyDecorator {
  return Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown>)[key];
    return raw === 'true' ? true : raw === 'false' ? false : raw;
  });
}
