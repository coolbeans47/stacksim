export interface InventorySeedItem {
  id: string;
  name: string;
  quantity: number;
}

export const initialInventory: readonly InventorySeedItem[] = [
  { id: "widget", name: "Widget", quantity: 4 },
  { id: "sprocket", name: "Sprocket", quantity: 3 },
  { id: "temporary", name: "Temporary", quantity: 1 },
];

export const updatedInventoryItem: InventorySeedItem = {
  id: "widget",
  name: "Widget Pro",
  quantity: 7,
};

export const removedInventoryItemId = "temporary";

export const expectedInventoryProjection: readonly InventorySeedItem[] = [
  { id: "sprocket", name: "Sprocket", quantity: 3 },
  updatedInventoryItem,
];
