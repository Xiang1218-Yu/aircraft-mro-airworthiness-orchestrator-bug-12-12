import type { AircraftPositionRecord } from '../domain/types.js';
import { Store } from '../store/store.js';

export class AircraftConfigurationService {
  constructor(private readonly store: Store) {}

  async install(record: AircraftPositionRecord): Promise<void> {
    return this.store.lock.runExclusive(() => {
      const key = `${record.aircraftId}:${record.position}`;
      const order = this.store.workOrders.get(record.workOrderId);
      if (!order) throw new Error('work order not found');
      if (!this.store.stocks.has(record.stockId)) throw new Error('stock not found');

      const current = this.store.aircraftPositions.get(key);
      if (current?.receiptId === record.receiptId) {
        if (current.stockId !== record.stockId) throw new Error('install receipt fingerprint conflict');
        return; // duplicate delivery of the receipt that produced the current state
      }
      const replayed = this.store.aircraftPositionHistory.find((item) => item.receiptId === record.receiptId);
      if (replayed) {
        if (replayed.stockId !== record.stockId || replayed.aircraftId !== record.aircraftId || replayed.position !== record.position) {
          throw new Error('install receipt fingerprint conflict');
        }
        return; // duplicate of an already superseded/removed receipt: never re-apply it over newer state
      }
      if (current && record.installedAt < current.installedAt) {
        // An install receipt older than the occupant must not override the newer installation.
        this.store.addAudit(order.tenantId, 'aircraft-position.stale-install', 'aircraft-position', key, { stockId: record.stockId, currentStockId: current.stockId, installedAt: record.installedAt, currentInstalledAt: current.installedAt });
        return;
      }
      const samePart = [...this.store.aircraftPositions.values()].find((item) => item.stockId === record.stockId);
      if (samePart) throw new Error('serialized part already installed');

      // All validation is done; the mutations below are all-or-nothing, so a
      // conflict can never leave a half-written configuration or work order.
      if (current) {
        // Atomic replacement: the previous occupant moves to history and any
        // late removal receipt for it will be ignored as stale.
        this.store.aircraftPositionHistory.push({ ...current, removedAt: record.installedAt });
      }
      this.store.aircraftPositions.set(key, {
        aircraftId: record.aircraftId,
        position: record.position,
        stockId: record.stockId,
        workOrderId: record.workOrderId,
        receiptId: record.receiptId,
        installedAt: record.installedAt,
      });
      order.installedParts.push({ receiptId: record.receiptId, stockId: record.stockId, workOrderId: record.workOrderId, aircraftId: record.aircraftId, position: record.position, installedAt: record.installedAt });
      order.version += 1;
      const metadata: Record<string, string | number | boolean> = { stockId: record.stockId, workOrderId: record.workOrderId };
      if (current) metadata.replacedStockId = current.stockId;
      this.store.addAudit(order.tenantId, 'aircraft-position.installed', 'aircraft-position', key, metadata);
      this.store.addOutbox(order.tenantId, 'mro.aircraft-configuration', record.aircraftId, { position: record.position, stockId: record.stockId, receiptId: record.receiptId, replacedStockId: current?.stockId ?? null });
    });
  }

  async remove(aircraftId: string, position: string, stockId: string, removedAt: string): Promise<void> {
    return this.store.lock.runExclusive(() => {
      const key = `${aircraftId}:${position}`;
      const current = this.store.aircraftPositions.get(key);
      if (!current) {
        const alreadyClosed = this.store.aircraftPositionHistory.some((item) => item.aircraftId === aircraftId && item.position === position && item.stockId === stockId);
        if (alreadyClosed) return; // duplicate removal receipt
        throw new Error('position is empty');
      }
      if (current.stockId !== stockId) {
        // Late removal for a part that is no longer current: it must not
        // override the newer installation now occupying the position.
        this.store.addAudit(this.tenantOf(current.workOrderId), 'aircraft-position.stale-removal', 'aircraft-position', key, { stockId, currentStockId: current.stockId });
        return;
      }
      current.removedAt = removedAt;
      this.store.aircraftPositions.delete(key);
      this.store.aircraftPositionHistory.push(current);
      const tenantId = this.tenantOf(current.workOrderId);
      this.store.addAudit(tenantId, 'aircraft-position.removed', 'aircraft-position', key, { stockId });
      this.store.addOutbox(tenantId, 'mro.aircraft-configuration', aircraftId, { position, removedStockId: stockId });
    });
  }

  private tenantOf(workOrderId: string): string {
    return this.store.workOrders.get(workOrderId)?.tenantId ?? 'system';
  }
}
