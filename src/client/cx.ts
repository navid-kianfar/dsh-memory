/**
 * Class-name joining.
 *
 * `clsx` is what the harness's own components use, but it is not a module-table specifier, so an
 * out-of-tree browser half would have to bundle a private copy of it into every plugin. Three lines
 * cover everything this package needs.
 * @module @achasoft/dsh-memory/client/cx
 */

/** One class-name argument: a name, or a falsy value to skip. */
export type ClassValue = string | false | null | undefined

/**
 * Join class names, dropping the falsy ones.
 * @param values - names and conditional names.
 * @returns the joined class attribute, empty when nothing applied.
 */
export function cx(...values: readonly ClassValue[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '').join(' ')
}
