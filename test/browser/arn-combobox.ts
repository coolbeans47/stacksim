import { expect, type Locator } from "@playwright/test";

/** Enter a value in the editable resource picker and commit it like a keyboard user. */
export async function fillArnCombobox(locator: Locator, value: string): Promise<void> {
  await locator.fill(value);
  await locator.press("Escape");
  await locator.blur();
  await expect(locator).toHaveValue(value);
}

/** Add a value to the tokenized multi-resource picker. */
export async function addArnComboboxValue(locator: Locator, value: string): Promise<void> {
  await locator.fill(value);
  await locator.press("Escape");
  await locator.press("Enter");
  await expect(locator).toHaveValue("");
}
