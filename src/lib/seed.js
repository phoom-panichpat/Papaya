import { supabase } from "./supabase";

// Dev-only: populate the signed-in user's account with realistic demo data so
// screens can be seen/tested before the create/edit flows exist. Safe to call
// repeatedly — it no-ops if the user already has recordings.
export async function seedDemo() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const owner_id = user.id;

  const { data: existing } = await supabase.from("recordings").select("id").limit(1);
  if (existing && existing.length) return;

  const { data: selfArr } = await supabase.from("people").select("*").eq("is_self", true).limit(1);
  const self = selfArr?.[0];
  if (!self) return;

  const { data: friends } = await supabase
    .from("people")
    .insert([
      { owner_id, display_name: "Ana", avatar_emoji: "🦊", avatar_color: "#E8622A", is_token: true },
      { owner_id, display_name: "Rui", avatar_emoji: "🐢", avatar_color: "#4E7A51", is_token: true },
      { owner_id, display_name: "Sofia", avatar_emoji: "🐝", avatar_color: "#C9A227", is_token: true },
      { owner_id, display_name: "Marco", avatar_emoji: "🐨", avatar_color: "#7A6E8E", is_token: true },
    ])
    .select();
  const [ana, rui, sofia] = friends;

  async function recording(name, base_currency, exchange_rate, is_active, members, expenses) {
    const { data: rec } = await supabase
      .from("recordings")
      // the demo's rates are all THB-anchored, so that's the era it pins
      .insert({ owner_id, name, base_currency, exchange_rate, home_currency: "THB", is_active })
      .select()
      .single();
    await supabase
      .from("recording_members")
      .insert(members.map((p) => ({ recording_id: rec.id, person_id: p.id, owner_id })));
    for (const e of expenses) {
      // logged in the record's own currency → the only hop is base→home
      await addExpense(owner_id, rec.id, e.paidBy.id, e.title, e.amount, base_currency, e.members || members, exchange_rate);
    }
    return rec;
  }

  await recording("Seoul in June", "KRW", 0.026, true, [self, ana, rui], [
    { title: "Hongdae BBQ", amount: 64000, paidBy: self },
    { title: "Namsan cable car", amount: 33000, paidBy: ana },
    { title: "Guesthouse · night 1", amount: 120000, paidBy: self },
  ]);

  await recording("Busan weekend", "KRW", 0.026, false, [self, rui, sofia], [
    { title: "KTX tickets", amount: 118000, paidBy: rui },
    { title: "Raw fish market", amount: 52000, paidBy: self },
  ]);

  // loose KRW expenses: no record, so the single hop is KRW→home
  await addExpense(owner_id, null, self.id, "Airport taxi", 18000, "KRW", [self, ana], 0.026);
  await addExpense(owner_id, null, self.id, "Coffee run", 9500, "KRW", [self], 0.026);
}

// home_rate = this expense's native→home rate, pinned at creation (see toHome);
// home_currency = the currency it converts into, i.e. the expense's era.
async function addExpense(owner_id, recording_id, paid_by, title, total, currency, members, home_rate = 1, home_currency = "THB") {
  const { data: exp } = await supabase
    .from("expenses")
    .insert({ owner_id, recording_id, paid_by, title, total_amount: total, currency, home_rate, home_currency, exchange_rate: recording_id ? null : home_rate })
    .select()
    .single();
  const { data: item } = await supabase
    .from("expense_items")
    .insert({ owner_id, expense_id: exp.id, label: null, amount: total, is_rest: true })
    .select()
    .single();
  await supabase
    .from("expense_item_members")
    .insert(members.map((m) => ({ item_id: item.id, person_id: m.id, owner_id })));
}
