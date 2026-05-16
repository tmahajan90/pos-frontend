import { useState, useEffect, useCallback } from "react";
import db from "../db";
import { useOffline } from "../context/OfflineContext";
import { useAuth } from "../context/AuthContext";
import useAutoRefresh from "../hooks/useAutoRefresh";

const KITCHEN_STATUS = { pending: 0, cooking: 1, ready: 2, served: 3 };

const statusConfig = {
  [KITCHEN_STATUS.pending]: { label: "Pending", bg: "#1e293b", border: "#f59e0b", badgeBg: "#78350f", badgeColor: "#fbbf24" },
  [KITCHEN_STATUS.cooking]: { label: "Cooking", bg: "#1e293b", border: "#3b82f6", badgeBg: "#1e3a5f", badgeColor: "#60a5fa" },
  [KITCHEN_STATUS.ready]: { label: "Ready", bg: "#1e293b", border: "#22c55e", badgeBg: "#14532d", badgeColor: "#4ade80" },
  [KITCHEN_STATUS.served]: { label: "Served", bg: "#1e293b", border: "#a855f7", badgeBg: "#3b0764", badgeColor: "#c084fc" },
};

const nextStatus = {
  [KITCHEN_STATUS.pending]: KITCHEN_STATUS.cooking,
  [KITCHEN_STATUS.cooking]: KITCHEN_STATUS.ready,
  [KITCHEN_STATUS.ready]: KITCHEN_STATUS.served,
};

const nextLabel = {
  [KITCHEN_STATUS.pending]: "Start Cooking",
  [KITCHEN_STATUS.cooking]: "Mark Ready",
  [KITCHEN_STATUS.ready]: "Mark Served",
};

export default function KitchenPage() {

  // Debug: log user and token
  const { isOnline, triggerSync, syncing } = useOffline();
  const { user } = useAuth();
  console.log("KitchenPage: user", user);
  console.log("KitchenPage: auth_token", localStorage.getItem("auth_token"));
  const [orders, setOrders] = useState([]);
  const [staffMap, setStaffMap] = useState({});
  const [tableMap, setTableMap] = useState({});
  const [productMap, setProductMap] = useState({});
  const [filter, setFilter] = useState("all");

  // Manager, chef, kitchen, and admin can update. Only staff cannot.
  const canUpdateKitchenStatus = user && user.role && user.role !== "staff";


  // Always force a server fetch after hard refresh to update local DB
  const loadKitchen = useCallback(async () => {
    let allOrders = [];
    if (isOnline) {
      try {
        const { default: api } = await import("../services/api");
        let serverOrders = [];
        try {
          serverOrders = await api.get("/api/orders?status=draft,confirmed");
        } catch {
          const allServerOrders = await api.get("/api/orders");
          serverOrders = allServerOrders.filter((o) => o.status === "draft" || o.status === "confirmed");
        }
        if (Array.isArray(serverOrders)) {
          // Overwrite local DB with server orders for freshness
          await db.orders.clear();
          for (const order of serverOrders) {
            await db.orders.put({
              id: order.id,
              tenant_id: order.tenant_id,
              user_id: order.user_id,
              table_id: order.table_id || null,
              assigned_staff_id: order.assigned_staff_id || null,
              status: order.status,
              kitchen_status: order.kitchen_status ?? 0,
              total: parseFloat(order.total),
              subtotal: parseFloat(order.subtotal ?? order.total ?? 0),
              customer_name: order.customer_name,
              customer_phone: order.customer_phone,
              sync_status: "synced",
              created_at: order.created_at,
              updated_at: order.updated_at,
            });
          }
        }
      } catch (e) {
        // offline, continue with local DB
        console.warn("KitchenPage: Could not fetch orders from server", e);
      }
    }
    allOrders = await db.orders.toArray();

    const items = await db.order_items.toArray();
    const itemsByOrder = {};
    for (const item of items) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }

    const staff = await db.staff.toArray();
    const sMap = {};
    for (const s of staff) sMap[s.id] = s.name;
    setStaffMap(sMap);

    const tables = await db.pos_tables.toArray();
    const tMap = {};
    for (const t of tables) tMap[t.id] = t.name;
    setTableMap(tMap);

    const products = await db.products.toArray();
    const pMap = {};
    for (const p of products) pMap[p.id] = p.name;
    setProductMap(pMap);

    const enriched = allOrders
      .map((o) => ({
        ...o,
        kitchen_status: o.kitchen_status ?? 0,
        items: (itemsByOrder[o.id] || []).map((item) => ({
          ...item,
          product_name: item.name || pMap[item.product_id] || "Unknown",
        })),
      }))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    setOrders(enriched);
  }, []);

  useEffect(() => {
    loadKitchen();
  }, [loadKitchen]);

  useAutoRefresh(loadKitchen, 8000);

  const updateKitchenStatus = async (orderId, newStatus) => {
    await db.orders.update(orderId, {
      kitchen_status: newStatus,
      sync_status: "pending",
      updated_at: new Date().toISOString(),
    });
    if (isOnline) {
      try {
        const { syncService } = await import("../services/sync");
        const result = await syncService.pushPendingOrders();
        if (result && result.errors && result.errors.length > 0) {
          const errMsg = result.errors.map(e => `Order #${e.id}: ${e.errors.join(", ")}`).join("\n");
          alert("Sync error:\n" + errMsg);
        }
      } catch (err) {
        alert("Sync failed: " + (err?.message || err));
      }
    }
    loadKitchen();
  };

  const activeOrders = orders.filter((o) => (o.kitchen_status ?? 0) !== KITCHEN_STATUS.served);

  const filtered = filter === "all"
    ? activeOrders
    : orders.filter((o) => (o.kitchen_status ?? 0) === KITCHEN_STATUS[filter]);

  const counts = {
    all: activeOrders.length,
    pending: orders.filter((o) => (o.kitchen_status ?? 0) === 0).length,
    cooking: orders.filter((o) => (o.kitchen_status ?? 0) === 1).length,
    ready: orders.filter((o) => (o.kitchen_status ?? 0) === 2).length,
    served: orders.filter((o) => (o.kitchen_status ?? 0) === 3).length,
  };

  const totalItems = filtered.reduce((sum, o) => sum + o.items.length, 0);
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.title}>Kitchen Display</h1>
          <span style={styles.subtitle}>{filtered.length} orders · {totalItems} items</span>
        </div>
        <div style={styles.headerRight}>
          <span style={{ ...styles.dot, background: isOnline ? "#4caf50" : "#f44336" }} />
          <span style={styles.statusText}>{timeStr}</span>
          <button style={styles.syncBtn} onClick={triggerSync} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync"}
          </button>
        </div>
      </div>

      <div style={styles.filterBar}>
        {["all", "pending", "cooking", "ready", "served"].map((f) => {
          const cfg = f === "all"
            ? { label: "All", badgeBg: "#334155", badgeColor: "#94a3b8" }
            : statusConfig[KITCHEN_STATUS[f]];
          const active = filter === f;
          return (
            <button
              key={f}
              style={{ ...styles.filterBtn, ...(active ? { background: cfg.badgeBg, borderColor: cfg.badgeColor, color: cfg.badgeColor } : {}) }}
              onClick={() => setFilter(f)}
            >
              {cfg.label} <span style={styles.filterCount}>{counts[f]}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>✓</div>
          <div style={styles.emptyText}>No {filter === "all" ? "pending" : filter} orders</div>
          <div style={styles.emptySub}>All caught up!</div>
        </div>
      )}

      <div style={styles.grid}>
        {filtered.map((order) => {
          const age = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 60000);
          const urgent = age >= 15;
          const ks = order.kitchen_status ?? 0;
          const cfg = statusConfig[ks] || statusConfig[0];
          const hasNext = nextStatus[ks] !== undefined;
          // Debug log for button rendering
          console.log("Order", order.id, {
            userRole: user?.role,
            canUpdateKitchenStatus,
            ks,
            hasNext,
            orderStatus: order.status,
            kitchen_status: order.kitchen_status,
          });
          return (
            <div key={order.id} style={{ ...styles.ticket, background: cfg.bg, borderLeftColor: cfg.border }}>
              <div style={styles.ticketHeader}>
                <div style={styles.ticketHeaderLeft}>
                  <span style={styles.ticketId}>#{order.id.slice(0, 8).toUpperCase()}</span>
                  {order.table_id && tableMap[order.table_id] && (
                    <span style={styles.tableBadge}>{tableMap[order.table_id]}</span>
                  )}
                  <span style={styles.orderStatusBadge}>{order.status || "Unknown"}</span>
                </div>
                <div style={styles.ticketMeta}>
                  <span style={{ ...styles.ageBadge, background: urgent ? "#7f1d1d" : "#1e3a5f", color: urgent ? "#fca5a5" : "#93c5fd" }}>
                    {age}m
                  </span>
                  <span style={{ ...styles.statusBadge, background: cfg.badgeBg, color: cfg.badgeColor }}>
                    {cfg.label}
                  </span>
                </div>
              </div>

              {order.assigned_staff_id && staffMap[order.assigned_staff_id] && (
                <div style={styles.staffLine}>Staff: {staffMap[order.assigned_staff_id]}</div>
              )}

              <div style={styles.itemsList}>
                {order.items.map((item, idx) => (
                  <div key={item.id || idx} style={styles.itemRow}>
                    <span style={styles.itemQty}>{item.quantity}×</span>
                    <span style={styles.itemName}>{item.product_name}</span>
                  </div>
                ))}
              </div>

              <div style={styles.ticketFooter}>
                <span style={styles.itemCount}>{order.items.length} item{order.items.length !== 1 ? "s" : ""}</span>
                <span style={styles.ticketTime}>
                  {new Date(order.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>

              {hasNext && canUpdateKitchenStatus && (
                <button
                  style={styles.actionBtn}
                  onClick={() => updateKitchenStatus(order.id, nextStatus[ks])}
                >
                  {nextLabel[ks]}
                </button>
              )}
              {hasNext && !canUpdateKitchenStatus && (
                <button style={styles.disabledActionBtn} disabled>
                  {nextLabel[ks]}
                </button>
              )}
              {!hasNext && ks === KITCHEN_STATUS.served && (
                <div style={styles.servedLabel}>Served</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  container: { padding: 16, maxWidth: 1600, margin: "0 auto", minHeight: "100vh", background: "#0f172a" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  headerLeft: { display: "flex", alignItems: "baseline", gap: 12 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  title: { color: "#f1f5f9", margin: 0, fontSize: 24 },
  subtitle: { color: "#94a3b8", fontSize: 14 },
  dot: { width: 8, height: 8, borderRadius: "50%" },
  statusText: { color: "#94a3b8", fontSize: 13, fontWeight: 600 },
  syncBtn: { padding: "4px 12px", borderRadius: 4, border: "1px solid #334155", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 12 },
  filterBar: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  filterBtn: { padding: "6px 16px", borderRadius: 8, border: "1px solid #334155", background: "#1e293b", color: "#94a3b8", cursor: "pointer", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  filterCount: { background: "#334155", padding: "1px 6px", borderRadius: 4, fontSize: 11 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 },
  ticket: {
    borderRadius: 12,
    borderLeft: "5px solid #6366f1",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  ticketHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 },
  ticketHeaderLeft: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0 },
  ticketId: { color: "#f1f5f9", fontWeight: 700, fontSize: 15, fontFamily: "monospace" },
  tableBadge: { marginLeft: 8, background: "#334155", color: "#f1f5f9", padding: "2px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600 },
  ticketMeta: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  ageBadge: { padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 },
  statusBadge: { padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, textTransform: "uppercase" },
  staffLine: { fontSize: 12, color: "#a5b4fc", fontWeight: 500 },
  itemsList: { display: "flex", flexDirection: "column", gap: 4 },
  itemRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #334155" },
  itemQty: { color: "#f59e0b", fontWeight: 700, fontSize: 16, minWidth: 30 },
  itemName: { color: "#e2e8f0", fontSize: 14, fontWeight: 500 },
  ticketFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", color: "#64748b", fontSize: 12, paddingTop: 2 },
  itemCount: { fontWeight: 600 },
  ticketTime: { fontWeight: 500 },
  actionBtn: {
    padding: "8px 0",
    borderRadius: 8,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    textAlign: "center",
    marginTop: 2,
  },
  orderStatusBadge: {
    marginLeft: 8,
    padding: "2px 8px",
    borderRadius: 8,
    background: "#334155",
    color: "#e2e8f0",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "capitalize",
  },
  readyLabel: {
    padding: "8px 0",
    borderRadius: 8,
    background: "#14532d",
    color: "#4ade80",
    fontWeight: 700,
    fontSize: 13,
    textAlign: "center",
    marginTop: 2,
  },
  disabledActionBtn: {
    padding: "8px 0",
    borderRadius: 8,
    border: "none",
    background: "#475569",
    color: "#cbd5e1",
    fontWeight: 700,
    fontSize: 13,
    textAlign: "center",
    marginTop: 2,
    cursor: "not-allowed",
    opacity: 0.65,
  },
  servedLabel: {
    padding: "8px 0",
    borderRadius: 8,
    background: "#3b0764",
    color: "#c084fc",
    fontWeight: 700,
    fontSize: 13,
    textAlign: "center",
    marginTop: 2,
  },
  empty: { textAlign: "center", padding: 80, color: "#64748b" },
  emptyIcon: { fontSize: 48, color: "#22c55e", marginBottom: 12 },
  emptyText: { fontSize: 20, fontWeight: 600, color: "#94a3b8" },
  emptySub: { fontSize: 14, marginTop: 4 },
};
