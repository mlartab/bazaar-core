// Brick 4: strict schemas. Pure validation, no server, no storage.
//
// Each schema is plain data. validate(endpoint, request) checks a request
// against the named schema and returns { ok: true } or
// { ok: false, code: "INVALID_SCHEMA", field, message }.
// Rules: required fields, exact types, allowed values, unknown fields
// rejected. Move rule: price is required for OFFER and ACCEPT, forbidden
// for WALK.

export const SCHEMAS = {
  registerAgent: {
    fields: {
      id: { type: "string", required: true, nonEmpty: true },
      role: { type: "string", required: true, allowed: ["buyer", "seller"] },
    },
  },
  openDeal: {
    fields: {
      id: { type: "string", required: true, nonEmpty: true },
      buyer: { type: "string", required: true, nonEmpty: true },
      seller: { type: "string", required: true, nonEmpty: true },
      price: { type: "integer", required: true, min: 1 },
    },
  },
  move: {
    fields: {
      dealId: { type: "string", required: true, nonEmpty: true },
      key: { type: "string", required: true, nonEmpty: true },
      kind: { type: "string", required: true, allowed: ["OFFER", "ACCEPT", "WALK"] },
      // A priced move locks funds, so the amount must be present; a WALK
      // locks nothing, so any price on it is a client bug, not a discount.
      price: {
        type: "integer",
        min: 1,
        requiredWhen: { field: "kind", is: ["OFFER", "ACCEPT"] },
        forbiddenWhen: { field: "kind", is: ["WALK"] },
      },
    },
  },
  delivery: {
    fields: {
      id: { type: "string", required: true, nonEmpty: true },
      dealId: { type: "string", required: true, nonEmpty: true },
      status: { type: "string", required: true, allowed: ["PENDING", "SENT", "DELIVERED"] },
    },
  },
};

function fail(field, message) {
  return { ok: false, code: "INVALID_SCHEMA", field, message };
}

function matchesWhen(request, clause) {
  if (!clause) return false;
  return Array.isArray(clause.is) && clause.is.includes(request[clause.field]);
}

function checkType(rule, value) {
  if (rule.type === "string") return typeof value === "string";
  if (rule.type === "integer") return Number.isInteger(value);
  return false;
}

function typeName(rule) {
  return rule.type === "integer" ? "an integer" : "a string";
}

export function validate(endpoint, request) {
  const schema = SCHEMAS[endpoint];
  if (schema === undefined) {
    return fail("endpoint", `unknown endpoint: ${String(endpoint)}`);
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return fail("(request)", "request must be an object");
  }
  for (const key of Object.keys(request)) {
    if (!Object.hasOwn(schema.fields, key)) {
      return fail(key, `unknown field: ${key}`);
    }
  }
  for (const [name, rule] of Object.entries(schema.fields)) {
    const value = request[name];
    if (value === undefined) {
      if (rule.required || matchesWhen(request, rule.requiredWhen)) {
        return fail(name, `missing required field: ${name}`);
      }
      continue;
    }
    if (matchesWhen(request, rule.forbiddenWhen)) {
      return fail(name, `field is forbidden here: ${name}`);
    }
    if (!checkType(rule, value)) {
      return fail(name, `field ${name} must be ${typeName(rule)}`);
    }
    if (rule.nonEmpty && value.length === 0) {
      return fail(name, `field ${name} must not be empty`);
    }
    if (rule.min !== undefined && value < rule.min) {
      return fail(name, `field ${name} must be at least ${rule.min}`);
    }
    if (rule.allowed !== undefined && !rule.allowed.includes(value)) {
      return fail(name, `field ${name} must be one of: ${rule.allowed.join(", ")}`);
    }
  }
  return { ok: true };
}
