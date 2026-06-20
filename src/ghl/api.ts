/**
 * GHL domain operations used by the voice agent's tools.
 *
 * NOTE: GHL's v2 response shapes vary slightly by account/version. Where a
 * shape is uncertain it's parsed defensively and marked with TODO so it's easy
 * to confirm against the live account once GHL_* keys are in `.env`.
 */

import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import { ghlFetch } from "./client.ts";

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  companyName?: string;
  address1?: string;
}

/** Keep only digits for loose phone comparison (ignores +, spaces, dashes). */
function digits(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}

/** Look up a contact by phone number. Returns the best match or null. */
export async function findContactByPhone(phone: string): Promise<GhlContact | null> {
  if (!phone) return null;
  // GHL "duplicate search" is the documented phone/email lookup endpoint.
  // Falls back to the generic query search if needed.
  try {
    const res = await ghlFetch<{ contact?: GhlContact }>({
      path: "/contacts/search/duplicate",
      query: { locationId: env.ghlLocationId, number: phone },
    });
    if (res?.contact?.id) return res.contact;
  } catch (err) {
    log.warn("GHL duplicate search failed, trying query search", { err: String(err) });
  }

  const res = await ghlFetch<{ contacts?: GhlContact[] }>({
    path: "/contacts/",
    query: { locationId: env.ghlLocationId, query: phone, limit: 5 },
  });
  const target = digits(phone);
  const match = (res.contacts ?? []).find((c) => digits(c.phone ?? "") === target);
  return match ?? res.contacts?.[0] ?? null;
}

export interface UpsertContactInput {
  fullName?: string;
  phone?: string;
  email?: string;
  buildingName?: string;
  buildingAddress?: string;
  tags?: string[];
  source?: string;
}

/** Create or update a contact (matched on phone/email by GHL). */
export async function upsertContact(input: UpsertContactInput): Promise<GhlContact> {
  const [firstName, ...rest] = (input.fullName ?? "").trim().split(/\s+/);
  const res = await ghlFetch<{ contact: GhlContact }>({
    method: "POST",
    path: "/contacts/upsert",
    body: {
      locationId: env.ghlLocationId,
      firstName: firstName || undefined,
      lastName: rest.join(" ") || undefined,
      name: input.fullName || undefined,
      phone: input.phone || undefined,
      email: input.email || undefined,
      companyName: input.buildingName || undefined,
      address1: input.buildingAddress || undefined,
      tags: input.tags,
      source: input.source ?? "Inbound voice agent",
    },
  });
  return res.contact;
}

export async function addTags(contactId: string, tags: string[]): Promise<void> {
  if (!contactId || tags.length === 0) return;
  await ghlFetch({
    method: "POST",
    path: `/contacts/${contactId}/tags`,
    body: { tags },
  });
}

export interface CreateOpportunityInput {
  contactId: string;
  name: string;
  monetaryValue?: number;
}

/** Create a pipeline opportunity for a new inbound lead. */
export async function createOpportunity(input: CreateOpportunityInput): Promise<{ id?: string } | null> {
  if (!env.ghlPipelineId || !env.ghlPipelineStageId) {
    log.warn("Skipping opportunity — GHL_PIPELINE_ID / GHL_PIPELINE_STAGE_ID not set");
    return null;
  }
  const res = await ghlFetch<{ opportunity?: { id?: string } }>({
    method: "POST",
    path: "/opportunities/",
    body: {
      locationId: env.ghlLocationId,
      pipelineId: env.ghlPipelineId,
      pipelineStageId: env.ghlPipelineStageId,
      contactId: input.contactId,
      name: input.name,
      status: "open",
      monetaryValue: input.monetaryValue,
    },
  });
  return res.opportunity ?? null;
}

export interface FreeSlot {
  startTime: string; // ISO
  endTime?: string;
}

/**
 * Fetch free slots for the survey calendar over the next `days` days.
 * GHL returns an object keyed by date; we flatten it to a sorted list.
 */
export async function getFreeSlots(days = 14): Promise<FreeSlot[]> {
  if (!env.ghlCalendarId) return [];
  const now = Date.now();
  const res = await ghlFetch<Record<string, unknown>>({
    path: `/calendars/${env.ghlCalendarId}/free-slots`,
    query: {
      startDate: now,
      endDate: now + days * 24 * 60 * 60 * 1000,
      timezone: env.ghlTimezone,
    },
  });

  // TODO: confirm exact shape against the live calendar. Commonly:
  // { "2026-06-17": { slots: ["2026-06-17T10:00:00-04:00", ...] }, ... }
  const slots: FreeSlot[] = [];
  for (const value of Object.values(res ?? {})) {
    const list = (value as { slots?: string[] })?.slots;
    if (Array.isArray(list)) {
      for (const s of list) slots.push({ startTime: s });
    }
  }
  return slots.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export interface BookAppointmentInput {
  contactId: string;
  startTime: string; // ISO
  endTime?: string;
  title: string;
  notes?: string;
}

export async function bookAppointment(input: BookAppointmentInput): Promise<{ id?: string; startTime?: string } | null> {
  if (!env.ghlCalendarId) {
    log.warn("Skipping appointment — GHL_CALENDAR_ID not set");
    return null;
  }
  const res = await ghlFetch<{ id?: string; startTime?: string }>({
    method: "POST",
    path: "/calendars/events/appointments",
    body: {
      calendarId: env.ghlCalendarId,
      locationId: env.ghlLocationId,
      contactId: input.contactId,
      startTime: input.startTime,
      endTime: input.endTime,
      title: input.title,
      appointmentStatus: "confirmed",
      notes: input.notes,
    },
  });
  return res ?? null;
}
