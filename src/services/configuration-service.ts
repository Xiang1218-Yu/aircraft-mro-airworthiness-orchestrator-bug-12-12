import type { AircraftPositionRecord } from '../domain/types.js';
import { Store } from '../store/store.js';

export class AircraftConfigurationService {
  constructor(private readonly store: Store) {}

  async install(record: AircraftPositionRecord): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const key = `${record.aircraftId}:${record.position}`;

      // Duplicate shop receipt: already applied, safe to ignore.
      if (this.store.aircraftPositionHistory.some((item) => item.receiptId === record.receiptId)) return;

      // Validate everything before mutating anything, so a conflict leaves
      // no partial configuration or work-order state behind.
      const order = this.store.workOrders.get(record.workOrderId);
      if (!order) throw new Error('work order not found');
      if (order.aircraftId !== record.aircraftId) throw new Error('work order aircraft mismatch');
      if (this.store.aircraftPositions.has(key)) throw new Error('aircraft position is occupied');
      const activeElsewhere = [...this.store.aircraftPositions.values()].find((item) => item.stockId === record.stockId);
      if (activeElsewhere) throw new Error('serialized part already installed');

      const current: AircraftPositionRecord = { ...record };
      this.store.aircraftPositions.set(key, current);
      this.store.aircraftPositionHistory.push(current);
      order.installedParts.push({ receiptId: record.receiptId, stockId: record.stockId, workOrderId: record.workOrderId, aircraftId: record.aircraftId, position: record.position, installedAt: record.installedAt });
      order.version += 1;
      this.store.addAudit(order.tenantId, 'aircraft-position.installed', 'aircraft-position', key, { aircraftId: record.aircraftId, position: record.position, stockId: record.stockId, receiptId: record.receiptId, workOrderId: record.workOrderId });
      this.store.addOutbox(order.tenantId, 'mro.aircraft-configuration', record.aircraftId, { aircraftId: record.aircraftId, position: record.position, stockId: record.stockId, receiptId: record.receiptId, installedAt: record.installedAt });
    });
  }

  async remove(aircraftId: string, position: string, stockId: string, removedAt: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const key = `${aircraftId}:${position}`;
      const current = this.store.aircraftPositions.get(key);
      if (!current) {
        const alreadyRemoved = this.store.aircraftPositionHistory.some((item) => item.aircraftId === aircraftId && item.position === position && item.stockId === stockId && item.removedAt !== undefined);
        if (alreadyRemoved) return; // duplicate removal receipt
        throw new Error('position is empty');
      }
      // A late receipt for the previous part must not evict the newer installation.
      if (current.stockId !== stockId) throw new Error('stale removal: stock is not the current occupant');

      current.removedAt = removedAt;
      this.store.aircraftPositions.delete(key);
      const tenantId = this.store.workOrders.get(current.workOrderId)?.tenantId ?? 'system';
      this.store.addAudit(tenantId, 'aircraft-position.removed', 'aircraft-position', key, { aircraftId, position, stockId, receiptId: current.receiptId, removedAt });
      this.store.addOutbox(tenantId, 'mro.aircraft-configuration', aircraftId, { aircraftId, position, removedStockId: stockId, removedAt });
    });
  }
}
