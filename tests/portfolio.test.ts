import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, createAgreement, createOwner, createProperty, createTenant, createUnit, freezeToday, resetDatabase, V1 } from './helpers.js';

describe('properties, units and tenants', () => {
  let owner: string;
  let other: string;

  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
    owner = await createOwner('9000000001', 'Owner One');
    other = await createOwner('9000000002', 'Owner Two');
  });

  it('validates property input', async () => {
    const res = await api().post(`${V1}/properties`).set(auth(owner)).send({ name: '  ', type: 'castle', pincode: '12' }).expect(400);
    const fields = res.body.error.details.map((d: any) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'type', 'pincode']));
  });

  it('creates, reads, updates and lists properties with search and pagination', async () => {
    const created = await createProperty(owner, { name: 'Sunrise Plaza', type: 'complex', city: 'Lucknow', pincode: '226001' });
    expect(created).toMatchObject({ name: 'Sunrise Plaza', type: 'complex', city: 'Lucknow', stats: { units: 0 } });

    await createProperty(owner, { name: 'Lake View House', type: 'house', singleUnit: { defaultRent: 25000 } });
    const house = (await api().get(`${V1}/properties`).query({ search: 'lake' }).set(auth(owner)).expect(200)).body;
    expect(house.meta.total).toBe(1);
    expect(house.data[0].stats.units).toBe(1); // single-unit property created its unit

    const updated = await api().patch(`${V1}/properties/${created.id}`).set(auth(owner)).send({ city: 'Kanpur' }).expect(200);
    expect(updated.body.data.city).toBe('Kanpur');

    for (let i = 0; i < 3; i++) await createProperty(owner, { name: `Bulk ${i}`, type: 'shop' });
    const page = (await api().get(`${V1}/properties`).query({ page: 2, pageSize: 2, sort: 'name' }).set(auth(owner)).expect(200)).body;
    expect(page.meta).toMatchObject({ page: 2, pageSize: 2, total: 5, totalPages: 3, hasMore: true });
    const byType = (await api().get(`${V1}/properties`).query({ type: 'shop' }).set(auth(owner)).expect(200)).body;
    expect(byType.meta.total).toBe(3);
    await api().get(`${V1}/properties`).query({ sort: 'password' }).set(auth(owner)).expect(400);
  });

  it('rejects duplicate property and unit names', async () => {
    await createProperty(owner, { name: 'Unique Tower' });
    const dup = await api().post(`${V1}/properties`).set(auth(owner)).send({ name: 'unique tower', type: 'building' }).expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    // Same name is fine in another account.
    await createProperty(other, { name: 'Unique Tower' });

    const p = await createProperty(owner, { name: 'Unit Name Test' });
    await createUnit(owner, p.id, { name: 'G-1' });
    await api().post(`${V1}/units`).set(auth(owner)).send({ propertyId: p.id, name: 'g-1', type: 'shop' }).expect(409);
  });

  it('keeps accounts isolated', async () => {
    const mine = await createProperty(owner, { name: 'Private Estate' });
    await api().get(`${V1}/properties/${mine.id}`).set(auth(other)).expect(404);
    await api().patch(`${V1}/properties/${mine.id}`).set(auth(other)).send({ name: 'Hacked' }).expect(404);
    await api().delete(`${V1}/properties/${mine.id}`).set(auth(other)).expect(404);
    // Cannot attach a unit to someone else's property.
    await api().post(`${V1}/units`).set(auth(other)).send({ propertyId: mine.id, name: 'X', type: 'shop' }).expect(400);
    const list = (await api().get(`${V1}/properties`).set(auth(other)).expect(200)).body;
    expect(list.data.map((p: any) => p.name)).not.toContain('Private Estate');
  });

  it('tracks unit occupancy through agreements and filters units', async () => {
    const p = await createProperty(owner, { name: 'Occupancy Arcade' });
    const u1 = await createUnit(owner, p.id, { name: 'Shop A', defaultRent: 10000 });
    await createUnit(owner, p.id, { name: 'Shop B' });
    const u3 = await createUnit(owner, p.id, { name: 'Shop C' });
    const t1 = await createTenant(owner, { name: 'Occupant One', phone: '9811100001' });
    const t2 = await createTenant(owner, { name: 'Future Occupant', phone: '9811100002' });
    await createAgreement(owner, { unitId: u1.id, tenantId: t1.id, startDate: '2026-09-01', rentAmount: 10000, dueDay: 5 });
    await createAgreement(owner, { unitId: u3.id, tenantId: t2.id, startDate: '2026-10-01', rentAmount: 12000, dueDay: 1 });

    const all = (await api().get(`${V1}/units`).query({ propertyId: p.id }).set(auth(owner)).expect(200)).body;
    expect(all.meta.counts).toMatchObject({ all: 3, occupied: 1, vacant: 1, reserved: 1 });
    const occupied = (await api().get(`${V1}/units`).query({ propertyId: p.id, occupancy: 'occupied' }).set(auth(owner)).expect(200)).body;
    expect(occupied.data).toHaveLength(1);
    expect(occupied.data[0]).toMatchObject({ name: 'Shop A', tenant: { name: 'Occupant One' }, currentAgreement: { rentAmount: 10000, dueDay: 5 } });
    const bySearch = (await api().get(`${V1}/units`).query({ search: 'future' }).set(auth(owner)).expect(200)).body;
    expect(bySearch.data.map((u: any) => u.name)).toEqual([]); // reserved unit has no *current* tenant
    const property = (await api().get(`${V1}/properties/${p.id}`).set(auth(owner)).expect(200)).body.data;
    expect(property.stats).toMatchObject({ units: 3, occupied: 1, reserved: 1, vacant: 1, occupancyRate: 33.3 });
  });

  it('prevents double-booking a unit and deleting units with history', async () => {
    const p = await createProperty(owner, { name: 'Booking Test' });
    const u = await createUnit(owner, p.id, { name: 'Office 1' });
    const t1 = await createTenant(owner, { name: 'First', phone: '9811100010' });
    const t2 = await createTenant(owner, { name: 'Second', phone: '9811100011' });
    await createAgreement(owner, { unitId: u.id, tenantId: t1.id, startDate: '2026-09-01', rentAmount: 5000, dueDay: 1 });
    const res = await api()
      .post(`${V1}/agreements`)
      .set(auth(owner))
      .send({ unitId: u.id, tenantId: t2.id, startDate: '2026-09-10', rentAmount: 5000, dueDay: 1 })
      .expect(409);
    expect(res.body.error.message).toContain('already has an active agreement');

    const del = await api().delete(`${V1}/units/${u.id}`).set(auth(owner)).expect(409);
    expect(del.body.error.message).toContain('Archive');
    await api().post(`${V1}/units/${u.id}/archive`).set(auth(owner)).expect(409); // active agreement
    const empty = await createUnit(owner, p.id, { name: 'Office 2' });
    await api().delete(`${V1}/units/${empty.id}`).set(auth(owner)).expect(204);
  });

  it('manages tenants with validation, uniqueness and status filters', async () => {
    const bad = await api().post(`${V1}/tenants`).set(auth(owner)).send({ name: 'X', phone: '123', email: 'nope', gstin: 'bad' }).expect(400);
    expect(bad.body.error.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['phone', 'email', 'gstin']));

    const t = await createTenant(owner, { name: 'Kavya Rao', phone: '98111 22233', email: 'kavya@example.com', gstin: '09AAACR5055K1Z5' });
    expect(t).toMatchObject({ phone: '+919811122233', status: 'new', outstanding: 0, gstin: '09AAACR5055K1Z5' });
    await api().post(`${V1}/tenants`).set(auth(owner)).send({ name: 'Dup', phone: '+91 98111 22233' }).expect(409);

    const found = (await api().get(`${V1}/tenants`).query({ search: '22233' }).set(auth(owner)).expect(200)).body;
    expect(found.data.map((x: any) => x.name)).toEqual(['Kavya Rao']);
    const newOnes = (await api().get(`${V1}/tenants`).query({ status: 'new' }).set(auth(owner)).expect(200)).body;
    expect(newOnes.data.every((x: any) => x.status === 'new')).toBe(true);

    await api().delete(`${V1}/tenants/${t.id}`).set(auth(owner)).expect(204);
    await api().get(`${V1}/tenants/${t.id}`).set(auth(owner)).expect(404);
  });

  it('archives and restores a property together with its units', async () => {
    const p = await createProperty(owner, { name: 'Archive Me' });
    await createUnit(owner, p.id, { name: 'Room 1', type: 'room' });
    const archived = (await api().post(`${V1}/properties/${p.id}/archive`).set(auth(owner)).expect(200)).body.data;
    expect(archived.archived).toBe(true);
    const active = (await api().get(`${V1}/properties`).query({ search: 'Archive Me' }).set(auth(owner)).expect(200)).body;
    expect(active.meta.total).toBe(0);
    const listArchived = (await api().get(`${V1}/properties`).query({ archived: 'true' }).set(auth(owner)).expect(200)).body;
    expect(listArchived.data.map((x: any) => x.name)).toContain('Archive Me');
    const restored = (await api().post(`${V1}/properties/${p.id}/restore`).set(auth(owner)).expect(200)).body.data;
    expect(restored.units[0].archived).toBe(false);
    await api().delete(`${V1}/properties/${p.id}`).set(auth(owner)).expect(204);
  });
});
