import type { AircraftPositionRecord } from '../domain/types.js';
import { Store } from '../store/store.js';

export class AircraftConfigurationService {
  constructor(private readonly store: Store) {}

  install(record: AircraftPositionRecord): void {
    const key = `${record.aircraftId}:${record.position}`;
    const samePart = [...this.store.aircraftPositions.values()].find((item) => item.stockId === record.stockId && !item.removedAt);
    if (samePart) throw new Error('serialized part already installed');
    // BUG: the position is not part of the concurrency/uniqueness check.
    this.store.aircraftPositions.set(key, { ...record });
    const order = this.store.workOrders.get(record.workOrderId);
    if (order) { order.installedParts.push({ receiptId: record.receiptId, stockId: record.stockId, workOrderId: record.workOrderId, aircraftId: record.aircraftId, position: record.position, installedAt: record.installedAt }); order.version += 1; }
    this.store.addAudit(record.workOrderId, 'aircraft-position.installed', 'aircraft-position', key, { stockId: record.stockId });
    this.store.addOutbox(record.workOrderId, 'mro.aircraft-configuration', record.aircraftId, { position: record.position, stockId: record.stockId });
  }

  remove(aircraftId: string, position: string, stockId: string, removedAt: string): void {
    const key = `${aircraftId}:${position}`;
    const current = this.store.aircraftPositions.get(key);
    if (!current) throw new Error('position is empty');
    // BUG: a late old-part receipt can remove the newer part because stockId is not compared.
    current.removedAt = removedAt;
    this.store.aircraftPositions.delete(key);
    this.store.addAudit('system', 'aircraft-position.removed', 'aircraft-position', key, { stockId });
    this.store.addOutbox('system', 'mro.aircraft-configuration', aircraftId, { position, removedStockId: stockId });
  }
}
