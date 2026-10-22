import type { McpFamilyMember } from "@sezzlee/sdk-nestjs";

export const dynamicMethodsSource = "dynamic-methods";

/**
 * Stands in for a backend's own table of dispatchable methods. The agent-client `family` scenario
 * asserts these names, keys and bodies.
 */
export const dynamicMethods: readonly McpFamilyMember[] = [
  {
    key: "3f2c9a1e-8b4d-4c6a-9e21-7d5b0c4a1f10",
    name: "list_customer_balances",
    description: "Lists customer balances, optionally above a minimum.",
    body: {
      type: "object",
      properties: {
        minBalance: {
          type: "number",
          description: "Lowest balance to include.",
        },
      },
    },
    readOnly: true,
  },
  {
    key: "b27e5d04-61a3-4f8e-a0c9-2e8d7f13b5a6",
    name: "list_delayed_orders",
    description: "Lists orders delivered later than promised.",
    body: {
      type: "object",
      properties: { days: { type: "integer", minimum: 1 } },
      required: ["days"],
    },
    readOnly: true,
  },
  {
    key: "e91b3c7f-0d2a-48e5-b6f4-5a1c9d8e2b07",
    name: "assign_courier",
    description: "Assigns a courier to an order.",
    body: {
      type: "object",
      properties: {
        orderNumber: { type: "string" },
        courierCode: { type: "string" },
      },
      required: ["orderNumber", "courierCode"],
    },
    destructive: true,
  },
];
