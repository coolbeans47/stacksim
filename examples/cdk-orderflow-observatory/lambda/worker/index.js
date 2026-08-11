"use strict";

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function requireOrder(order) {
  if (!order || typeof order !== "object") throw namedError("InvalidOrder", "Order input is required.");
  if (!String(order.orderId || "").trim()) throw namedError("InvalidOrder", "orderId is required.");
  if (!String(order.customer || "").trim()) throw namedError("InvalidOrder", "customer is required.");
  if (!Array.isArray(order.items) || order.items.length === 0) throw namedError("InvalidOrder", "At least one item is required.");
  for (const item of order.items) {
    if (!String(item?.sku || "").trim() || !Number.isInteger(item?.quantity) || item.quantity < 1) {
      throw namedError("InvalidOrder", "Every item needs a sku and a positive integer quantity.");
    }
  }
  return order;
}

exports.handler = async (event) => {
  const operation = event?.operation;

  if (operation === "validate") {
    const order = requireOrder(event.order);
    return { accepted: true, lineCount: order.items.length };
  }

  if (operation === "inventory") {
    const order = requireOrder(event.order);
    const attempt = Number(event.attempt || 0);
    if (order.failInventory) throw namedError("InventoryUnavailable", "The inventory service rejected this order.");
    if (attempt < Number(order.transientFailures || 0)) {
      throw namedError("InventoryTransientError", `Inventory reservation failed on attempt ${attempt + 1}.`);
    }
    return { reserved: true, warehouse: "LHR-04", attempt: attempt + 1 };
  }

  if (operation === "fraud") {
    const order = requireOrder(event.order);
    const score = Math.max(0, Math.min(100, Number(order.fraudScore || 0)));
    return {
      approved: score < 70,
      score,
      band: score < 30 ? "low" : score < 70 ? "review" : "high",
    };
  }

  if (operation === "package") {
    const item = event.item;
    if (!item?.sku) throw namedError("InvalidItem", "The map item is missing a sku.");
    if (event.failItem && event.failItem === item.sku) {
      throw namedError("PackagingError", `Packaging failed for ${item.sku}.`);
    }
    return {
      sku: item.sku,
      packageId: `${event.orderId}-P${Number(event.itemIndex) + 1}`,
      station: `PACK-${(Number(event.itemIndex) % 3) + 1}`,
    };
  }

  if (operation === "dispatch") {
    const packages = Array.isArray(event.packages) ? event.packages : [];
    return {
      trackingNumber: `OBS-${String(event.orderId).replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`,
      carrier: "Northstar Parcel",
      packageCount: packages.length,
      message: `${event.customer}'s order is in transit.`,
    };
  }

  if (operation === "compensate") {
    return {
      released: true,
      reason: event.error?.Error || "Workflow stage failed",
    };
  }

  throw namedError("UnknownOperation", `Unsupported workflow operation '${operation}'.`);
};
