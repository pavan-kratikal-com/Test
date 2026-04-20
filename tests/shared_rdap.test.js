// Unit tests for shared/rdap.js — parseRdapRegistration() pure function.
// Cache and background fetch are integration-tested against live services.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRdapRegistration } from "../shared/rdap.js";

test("parseRdapRegistration extracts registration and expiration dates", () => {
  const rdap = {
    events: [
      { eventAction: "registration", eventDate: "2023-06-15T12:00:00Z" },
      { eventAction: "expiration", eventDate: "2025-06-15T12:00:00Z" },
      { eventAction: "last changed", eventDate: "2024-01-01T00:00:00Z" },
    ],
    entities: [
      {
        roles: ["registrar"],
        vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar"]]],
      },
    ],
  };
  const result = parseRdapRegistration(rdap);
  assert.equal(result.registration_date.toISOString(), "2023-06-15T12:00:00.000Z");
  assert.equal(result.expiration_date.toISOString(), "2025-06-15T12:00:00.000Z");
  assert.equal(result.registrar, "Example Registrar");
});

test("parseRdapRegistration returns nulls for empty events", () => {
  const result = parseRdapRegistration({ events: [] });
  assert.equal(result.registration_date, null);
  assert.equal(result.expiration_date, null);
  assert.equal(result.registrar, null);
});

test("parseRdapRegistration returns nulls for missing events key", () => {
  const result = parseRdapRegistration({});
  assert.equal(result.registration_date, null);
  assert.equal(result.expiration_date, null);
  assert.equal(result.registrar, null);
});

test("parseRdapRegistration returns nulls for null/undefined input", () => {
  assert.deepEqual(parseRdapRegistration(null),
    { registration_date: null, expiration_date: null, registrar: null });
  assert.deepEqual(parseRdapRegistration(undefined),
    { registration_date: null, expiration_date: null, registrar: null });
});

test("parseRdapRegistration ignores invalid date strings", () => {
  const rdap = {
    events: [
      { eventAction: "registration", eventDate: "not-a-date" },
    ],
  };
  const result = parseRdapRegistration(rdap);
  assert.equal(result.registration_date, null);
});

test("parseRdapRegistration falls back to entity handle when no vcard fn", () => {
  const rdap = {
    events: [],
    entities: [
      { roles: ["registrar"], handle: "REG-123" },
    ],
  };
  const result = parseRdapRegistration(rdap);
  assert.equal(result.registrar, "REG-123");
});
