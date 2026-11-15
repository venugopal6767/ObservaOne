// Icons for metric categories and metrics (Explorer, Templates).
import {
  Server, Boxes, AppWindow, Database, Network, Cloud, Layers, Monitor, Terminal, Code2, Cpu, MemoryStick, HardDrive, Activity,
  AlertTriangle, Gauge, ListOrdered, RotateCcw, Box, Zap, Timer, Coffee, Unplug, type LucideIcon,
} from 'lucide-react';
import type { Category } from '@/lib/catalog';

export const CATEGORY_ICONS: Record<Category, LucideIcon> = {
  system: Server, kubernetes: Boxes, applications: AppWindow, databases: Database, network: Network,
  cloud: Cloud, vmware: Layers, windows: Monitor, linux: Terminal, custom: Code2,
};
const METRIC_ICONS: Record<string, LucideIcon> = {
  cpu: Cpu, memory: MemoryStick, disk: HardDrive, network: Activity, net_errors: AlertTriangle, load: Gauge, processes_cpu: ListOrdered,
  pod_cpu: Cpu, pod_memory: MemoryStick, pod_restarts: RotateCcw, pods_running: Box, pvc_usage: HardDrive,
  rps: Zap, errors: AlertTriangle, latency: Timer, jvm_heap: Coffee,
  db_connections: Database, db_tps: Database, db_size: Database,
  if_traffic: Network, if_errors: AlertTriangle, if_down: Unplug,
  esxi_cpu: Layers, esxi_mem: Layers, vm_cpu: Server, datastore: HardDrive,
};
export const metricIcon = (id: string): LucideIcon => METRIC_ICONS[id] || Activity;
