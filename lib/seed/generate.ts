import type {
  Badge,
  Branch,
  Employee,
  Incident,
  Inventory,
  PolicyDocument,
  Product,
  Profile,
  SalesOrder,
  SalesTarget,
  SeedData,
  Staffing,
  Ticket
} from '../contracts';

const regions = ['east', 'central', 'south'] as const;
const productNames = [
  'Demo Jasmine Rice 5kg', 'Demo Brown Rice 2kg', 'Demo Cooking Oil 1L', 'Demo Fish Sauce 700ml',
  'Demo Soy Sauce 500ml', 'Demo Instant Noodles Pack', 'Demo Canned Tuna 185g', 'Demo Coconut Milk 400ml',
  'Demo Green Tea 500ml', 'Demo Bottled Water 1.5L', 'Demo Ground Coffee 250g', 'Demo Tea Bags 25ct',
  'Demo Oat Drink 1L', 'Demo UHT Milk 1L', 'Demo Orange Juice 1L', 'Demo Chili Paste 200g',
  'Demo Palm Sugar 500g', 'Demo Sea Salt 500g', 'Demo Wheat Flour 1kg', 'Demo Pasta 500g',
  'Demo Tomato Sauce 500g', 'Demo Peanut Snack 150g', 'Demo Potato Chips 100g', 'Demo Crackers 200g',
  'Demo Dish Soap 500ml', 'Demo Laundry Liquid 1L', 'Demo Hand Soap 250ml', 'Demo Tissue Box 6ct',
  'Demo Paper Towels 2ct', 'Demo Toothpaste 120g', 'Demo Shampoo 400ml', 'Demo Conditioner 400ml',
  'Demo Fresh Eggs 10ct', 'Demo Fresh Milk 2L', 'Demo Bananas 1kg', 'Demo Apples 1kg',
  'Demo Tomatoes 1kg', 'Demo Leafy Greens 300g', 'Demo Chicken 1kg', 'Demo Tofu 300g'
] as const;
const productCategories = [
  'Pantry', 'Beverages', 'Snacks', 'Household', 'Personal care', 'Fresh food'
] as const;

function makeRandom(seed: number): () => number {
  let state = Number(BigInt.asUintN(32, BigInt(seed) ^ (BigInt(seed) >> 32n) ^ 0x6d2b79f5n));
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function dateOnlyUtc(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('businessDate must be an ISO calendar date (YYYY-MM-DD)');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError('businessDate must be a valid ISO calendar date');
  }
  return parsed;
}

function addDays(date: Date, amount: number): string {
  const shifted = new Date(date.valueOf() + amount * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

function localTimestamp(date: string, hour: number, minute: number, second = 0): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}+07:00`;
}

function distribute(total: number, count: number, random: () => number): number[] {
  if (count <= 0) return [];
  const weights = Array.from({ length: count }, () => randomInt(random, 1, 1_000));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const amounts = weights.map((weight) => Math.floor(total * weight / weightTotal));
  const remainder = total - amounts.reduce((sum, amount) => sum + amount, 0);
  for (let index = 0; index < remainder; index += 1) amounts[index] += 1;
  return amounts;
}

function branchId(region: string, number: number): string {
  const prefix = region === 'east' ? 'E' : region === 'central' ? 'C' : 'S';
  return `${prefix}${String(number + 1).padStart(2, '0')}`;
}

function orderStatusCounts(branch: Branch, dayIndex: number, orderCount: number, cellIndex: number) {
  let refunded = cellIndex % 7 === 0 ? 1 : 0;
  let cancelled = cellIndex % 3 === 0 ? 1 : 0;
  if (branch.id === 'E02' && dayIndex === 29) {
    refunded = 3;
    cancelled = 10;
  }
  return { refunded, cancelled, paid: orderCount - refunded - cancelled };
}

function dailySalesRatio(branch: Branch, dayIndex: number, random: () => number): number {
  const jitter = (random() - 0.5) * 0.06;
  if (branch.id === 'E01' && dayIndex >= 23) return 0.78 + jitter;
  if (branch.id === 'E02' && dayIndex === 29) return 0.62 + jitter;
  if (branch.id === 'E03' && dayIndex === 29) return 0.58 + jitter;
  if (branch.id === 'E04' && dayIndex === 29) return 1.28 + jitter;
  return 0.99 + jitter;
}

function incidentDays(branch: Branch): number[] {
  if (branch.id === 'E03') return [3, 9, 15, 21, 27];
  return [4, 10, 16, 22, 29];
}

export function createSeedData(businessDate: string, seed = 1): SeedData {
  if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer');
  const businessDateUtc = dateOnlyUtc(businessDate);
  const random = makeRandom(seed);
  // businessDate is the completed day queried by core; include it in the 30-day window.
  const dates = Array.from({ length: 30 }, (_, index) => addDays(businessDateUtc, index - 29));
  const closedDate = dates[dates.length - 1];

  const branches: Branch[] = regions.flatMap((region) =>
    Array.from({ length: 4 }, (_, index) => ({
      id: branchId(region, index),
      name: `Demo ${region[0].toUpperCase()}${region.slice(1)} Branch ${index + 1}`,
      region
    }))
  );
  const products: Product[] = productNames.map((name, index) => ({
    id: `P${String(index + 1).padStart(3, '0')}`,
    name,
    category: productCategories[index % productCategories.length]
  }));

  const profiles: Profile[] = [
    {
      id: 'executive',
      name: 'Demo Executive',
      role: 'executive',
      active: true,
      permissions: ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create', 'demo.update'],
      regions: [...regions]
    },
    {
      id: 'east',
      name: 'Demo East Manager',
      role: 'east_manager',
      active: true,
      permissions: ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create'],
      regions: ['east']
    },
    {
      id: 'hr',
      name: 'Demo HR Administrator',
      role: 'hr_admin',
      active: true,
      permissions: ['hr.read', 'badge.revoke'],
      regions: [...regions]
    },
    {
      // HR Director (Workflow V2 onboarding approver): exactly the V2 director permissions; no HR Admin authority.
      // Its directory identity, responsibility and onboarding requests are seeded by lib/seed/workflow-v2.ts.
      id: 'director',
      name: 'Demo HR Director',
      role: 'hr_director',
      active: true,
      permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'],
      regions: ['east']
    }
  ];

  const employees: Employee[] = Array.from({ length: 80 }, (_, index) => ({
    id: `E${String(index + 1).padStart(3, '0')}`,
    name: `Demo Employee ${String(index + 1).padStart(3, '0')}`,
    branchId: index === 79 ? null : index === 23 ? 'E02' : branches[index % branches.length].id,
    active: index !== 78
  }));
  const badges: Badge[] = employees.map((employee, index) => ({
    id: index === 23 ? 'C102' : `C${String(index + 1).padStart(3, '0')}`,
    employeeId: employee.id,
    state: index === 77 ? 'revoked' : 'active',
    version: index === 77 ? 2 : 1,
    updatedAt: localTimestamp(closedDate, 12, index % 60),
    ...(index === 77 ? { operationKey: 'seed:badge-revocation:E078' } : {})
  }));

  const sales_targets: SalesTarget[] = [];
  const sales_orders: SalesOrder[] = [];
  let orderNumber = 1;
  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const date = dates[dayIndex];
    for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
      const branch = branches[branchIndex];
      const cellIndex = dayIndex * branches.length + branchIndex;
      const baseTarget = 700_000 + branchIndex * 12_000 + (dayIndex % 7) * 8_000;
      const target = baseTarget + randomInt(random, -18_000, 18_000);
      sales_targets.push({
        id: `TGT-${branch.id}-${date}`,
        branchId: branch.id,
        date,
        amountSatang: target,
        updatedAt: localTimestamp(date, 23, 59, 59)
      });

      const count = 27 + (cellIndex < 280 ? 1 : 0);
      const statuses = orderStatusCounts(branch, dayIndex, count, cellIndex);
      const paidSales = Math.max(1, Math.round(target * dailySalesRatio(branch, dayIndex, random)));
      const refunds = Array.from({ length: statuses.refunded }, () => randomInt(random, 12_000, 42_000));
      const paidAmounts = distribute(paidSales, statuses.paid, random);
      const cancelledAmounts = distribute(randomInt(random, 12_000, 40_000) * statuses.cancelled, statuses.cancelled, random);
      const rows = [
        ...paidAmounts.map((amountSatang) => ({ status: 'paid' as const, amountSatang })),
        ...refunds.map((amountSatang) => ({ status: 'refunded' as const, amountSatang })),
        ...cancelledAmounts.map((amountSatang) => ({ status: 'cancelled' as const, amountSatang }))
      ];
      for (let localIndex = 0; localIndex < rows.length; localIndex += 1) {
        const row = rows[localIndex];
        let hour = 10 + (localIndex % 12);
        let minute = randomInt(random, 0, 59);
        if (branch.id === 'E02' && dayIndex === 29 && row.status !== 'paid') {
          hour = 18;
          minute = 10 + (localIndex % 80);
          if (minute >= 60) {
            hour += 1;
            minute -= 60;
          }
        }
        sales_orders.push({
          id: `SO-${String(orderNumber++).padStart(5, '0')}`,
          branchId: branch.id,
          date,
          amountSatang: row.amountSatang,
          status: row.status,
          updatedAt: localTimestamp(date, hour, minute, randomInt(random, 0, 59))
        });
      }
    }
  }

  const inventory_snapshots: Inventory[] = [];
  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const date = dates[dayIndex];
    for (const branch of branches) {
      for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
        const product = products[productIndex];
        const minimum = 8 + (productIndex % 8);
        const stockOutage = branch.id === 'E01' && dayIndex >= 25 && productIndex < 4;
        const onHand = stockOutage
          ? randomInt(random, 0, minimum - 1)
          : minimum + randomInt(random, branch.id === 'E03' ? 8 : 2, 28);
        const observedAt = localTimestamp(date, 23, 59, 59);
        inventory_snapshots.push({
          id: `INV-${branch.id}-${product.id}-${date}`,
          branchId: branch.id,
          productId: product.id,
          date,
          onHand,
          minimum,
          observedAt,
          updatedAt: observedAt
        });
      }
    }
  }

  const incidents: Incident[] = [];
  for (const branch of branches) {
    for (const dayIndex of incidentDays(branch)) {
      const date = dates[dayIndex];
      const isEastShortage = branch.id === 'E01' && dayIndex === 29;
      const isPaymentIssue = branch.id === 'E02' && dayIndex === 29;
      const isAboveTargetIssue = branch.id === 'E04' && dayIndex === 29;
      const kind: Incident['kind'] = isEastShortage ? 'stock' : isPaymentIssue ? 'payment' : 'operations';
      const startedAt = localTimestamp(date, isPaymentIssue ? 18 : isEastShortage ? 9 : 14, 0);
      const remainsOpen = isEastShortage || isAboveTargetIssue || (dayIndex === 28 && (branch.id === 'C03' || branch.id === 'S02'));
      const endedAt = remainsOpen ? null : localTimestamp(date, isPaymentIssue ? 19 : isAboveTargetIssue ? 18 : 16, isPaymentIssue ? 45 : 30);
      const title = isEastShortage
        ? 'Demo stock below minimum on four pantry products'
        : isPaymentIssue
          ? 'Demo card-terminal interruption; affected orders were cancelled or refunded'
          : isAboveTargetIssue
            ? 'Demo delivery delay while branch sales exceeded target'
            : `${kind === 'stock' ? 'Demo stock count' : kind === 'payment' ? 'Demo payment terminal' : 'Demo store operations'} follow-up`;
      incidents.push({
        id: `INC-${String(incidents.length + 1).padStart(3, '0')}`,
        branchId: branch.id,
        date,
        title,
        kind,
        status: remainsOpen ? 'open' : 'resolved',
        startedAt,
        endedAt,
        updatedAt: endedAt ?? localTimestamp(closedDate, 21, 45)
      });
    }
  }

  const staffing_summaries: Staffing[] = dates.flatMap((date, dayIndex) =>
    branches.map((branch, branchIndex) => {
      const planned = 7 + (branchIndex % 3);
      const shortStaff = branch.id === 'E01' && dayIndex >= 25;
      const actual = shortStaff ? planned : Math.max(4, planned - randomInt(random, 0, branch.id === 'E03' ? 0 : 2));
      const observedAt = localTimestamp(date, 23, 59, 59);
      return {
        id: `STF-${branch.id}-${date}`,
        branchId: branch.id,
        date,
        planned,
        actual,
        observedAt,
        updatedAt: observedAt
      };
    })
  );

  const tickets: Ticket[] = [];
  const employeesByBranch = new Map<string, Employee[]>();
  for (const employee of employees) {
    if (!employee.branchId) continue;
    const people = employeesByBranch.get(employee.branchId) ?? [];
    people.push(employee);
    employeesByBranch.set(employee.branchId, people);
  }
  for (let index = 0; index < 30; index += 1) {
    const branch = branches[index % branches.length];
    const assigned = employeesByBranch.get(branch.id) ?? [];
    const assignee = assigned[index % assigned.length];
    const incident = incidents.find((item) => item.branchId === branch.id && item.status === 'open')
      ?? incidents.find((item) => item.branchId === branch.id);
    const createdDate = dates[(index * 7) % (dates.length - 1)];
    tickets.push({
      id: `TCK-${String(index + 1).padStart(3, '0')}`,
      branchId: branch.id,
      assigneeId: assignee.id,
      title: incident?.kind === 'stock' ? 'Review demo replenishment levels' : 'Review demo branch operating note',
      reason: incident?.title ?? 'Scheduled synthetic follow-up for the demo branch',
      unansweredQuestion: 'Which additional evidence is needed to assess this synthetic branch issue?',
      sourceIds: incident ? [incident.id] : [],
      status: 'open',
      operationKey: `seed:ticket:${index + 1}`,
      createdAt: localTimestamp(createdDate, 10 + (index % 8), index % 60)
    });
  }

  const policy_documents: PolicyDocument[] = [
    {
      id: 'POL-OPS-001',
      title: 'Demo incident and ticket handling policy',
      version: '1.0',
      text: 'Source metadata: synthetic NEXUS demonstration fixture; version 1.0; no real company content. Training policy: document the branch, business date, observed facts, and unresolved question. Escalate a payment incident with affected order references; do not infer a root cause from sales variance alone.',
      updatedAt: localTimestamp(closedDate, 20, 0)
    },
    {
      id: 'POL-HR-001',
      title: 'Demo badge revocation policy',
      version: '1.0',
      text: 'Source metadata: synthetic NEXUS demonstration fixture; version 1.0; no real company content. Training policy: badge revocation requires requester confirmation, an employee and badge match, a reason, and an independent readback of the final badge state.',
      updatedAt: localTimestamp(closedDate, 20, 0)
    }
  ];

  return {
    profiles,
    branches,
    products,
    sales_orders,
    sales_targets,
    inventory_snapshots,
    incidents,
    staffing_summaries,
    employees,
    policy_documents,
    mock_badges: badges,
    mock_tickets: tickets
  };
}
