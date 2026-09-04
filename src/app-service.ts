import { AccountSnapshot, GameData, Settings } from './domain/types';
import { LocalStore } from './data/local-store';
import { ToolboxGameDataProvider } from './data/game-data-provider';
import { SklandClient } from './data/skland-client';
import { MasteryPlanner } from './engine/mastery';
import { PromotionPlanner } from './engine/promotion';
import { ModulePlanner } from './engine/module';
import { recursiveCraftableQuantity } from './engine/crafting';
import { unlimitedMaterialGroups } from './domain/mastery-materials';
import { buildAccountStatistics } from './engine/statistics';

export class AppService {
  private gameData!: GameData;
  private account: AccountSnapshot | null = null;
  private settings!: Settings;
  private usingCache = true;
  private lastError = '';
  private stateRevision = 0;
  private cachedState?: Awaited<ReturnType<AppService['buildState']>>;
  private statePromise?: Promise<Awaited<ReturnType<AppService['buildState']>>>;
  private cachedPlans?: ReturnType<AppService['buildPlans']>;
  private masteryPlanner!: MasteryPlanner;
  private promotionPlanner!: PromotionPlanner;
  private modulePlanner!: ModulePlanner;
  private materialById = new Map<string, GameData['materials'][number]>();
  private parentMaterials = new Map<string, GameData['materials']>();
  private recipes: NonNullable<GameData['materials'][number]['recipe']>[] = [];
  private unlimitedMaterials!: ReturnType<typeof unlimitedMaterialGroups>;

  readonly gameProvider: ToolboxGameDataProvider;
  readonly skland: SklandClient;

  constructor(readonly store: LocalStore) {
    this.gameProvider = new ToolboxGameDataProvider(store);
    this.skland = new SklandClient(store);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    [this.gameData, this.account, this.settings] = await Promise.all([
      this.gameProvider.initialize(),
      this.store.readAccount(),
      this.store.readSettings(),
    ]);
    this.rebuildDerivedData();
    await this.sanitizeUnlimitedItems();
  }

  async state() {
    if (this.cachedState) return this.cachedState;
    if (this.statePromise) return this.statePromise;
    const revision = this.stateRevision;
    const pending = this.buildState();
    this.statePromise = pending;
    try {
      const result = await pending;
      if (revision === this.stateRevision) this.cachedState = result;
      return result;
    } finally {
      if (this.statePromise === pending) this.statePromise = undefined;
    }
  }

  async startupContext() {
    return {
      theme: this.settings.theme,
      loggedIn: Boolean(await this.store.readCredentials()),
      hasAccount: Boolean(this.account),
      autoRefresh: this.settings.autoRefresh,
    };
  }

  credentialsChanged(): void {
    this.invalidateState();
  }

  private async buildState() {
    const loggedIn = Boolean(await this.store.readCredentials());
    const plans = this.cachedPlans ??= this.buildPlans();
    return {
      loggedIn,
      account: this.account,
      gameData: this.gameData,
      settings: this.settings,
      statistics: buildAccountStatistics(this.gameData, this.account),
      unlimitedEligibleItemIds: [...this.unlimitedMaterials.blue],
      skillSummaryItemIds: [...this.unlimitedMaterials.skillSummaries],
      ...plans,
      usingCache: Boolean(this.account && this.usingCache),
      lastError: this.lastError,
    };
  }

  private buildPlans() {
    const empty = { single: [], continuous: [], singleReal: [], continuousReal: [] };
    if (!this.account) return { ...empty, promotions: empty, modules: empty };
    const { operators, inventory } = this.account;
    const unlimitedIds = this.settings.unlimitedItemIds;
    const singleReal = this.masteryPlanner.singleStage(operators, inventory, []);
    const continuousReal = this.masteryPlanner.continuous(operators, inventory, []);
    const single = unlimitedIds.length
      ? this.masteryPlanner.singleStage(operators, inventory, unlimitedIds)
      : singleReal;
    const continuous = unlimitedIds.length
      ? this.masteryPlanner.continuous(operators, inventory, unlimitedIds)
      : continuousReal;
    const promotionSingleReal = this.promotionPlanner.singleStage(operators, inventory, []);
    const promotionContinuousReal = this.promotionPlanner.continuous(operators, inventory, []);
    const moduleSingleReal = this.modulePlanner.singleStage(operators, inventory, []);
    const moduleContinuousReal = this.modulePlanner.continuous(operators, inventory, []);
    return {
      single,
      continuous,
      singleReal,
      continuousReal,
      promotions: {
        single: unlimitedIds.length
          ? this.promotionPlanner.singleStage(operators, inventory, unlimitedIds)
          : promotionSingleReal,
        continuous: unlimitedIds.length
          ? this.promotionPlanner.continuous(operators, inventory, unlimitedIds)
          : promotionContinuousReal,
        singleReal: promotionSingleReal,
        continuousReal: promotionContinuousReal,
      },
      modules: {
        single: unlimitedIds.length
          ? this.modulePlanner.singleStage(operators, inventory, unlimitedIds)
          : moduleSingleReal,
        continuous: unlimitedIds.length
          ? this.modulePlanner.continuous(operators, inventory, unlimitedIds)
          : moduleContinuousReal,
        singleReal: moduleSingleReal,
        continuousReal: moduleContinuousReal,
      },
    };
  }

  async refreshAccount(uid?: string): Promise<ReturnType<AppService['state']>> {
    const selectedUid = uid || this.settings.selectedUid || this.account?.uid;
    if (!selectedUid) throw new Error('请先选择森空岛绑定角色');
    try {
      const next = await this.skland.fetchAccount(selectedUid);
      const bindings = await this.skland.getBindings().catch(() => []);
      next.nickname = bindings.find(x => x.uid === selectedUid)?.nickName;
      this.account = next;
      this.settings = { ...this.settings, selectedUid };
      await Promise.all([this.store.writeAccount(next), this.store.writeSettings(this.settings)]);
      this.usingCache = false;
      this.lastError = '';
      this.invalidateState(true);
      await this.store.log('account-refresh-success');
    } catch (error) {
      this.lastError = (error as Error).message;
      this.invalidateState();
      await this.store.log('account-refresh-failure', this.lastError);
      throw error;
    }
    return this.state();
  }

  async updateGameData(): Promise<ReturnType<AppService['state']>> {
    try {
      this.gameData = await this.gameProvider.update();
      this.rebuildDerivedData();
      await this.sanitizeUnlimitedItems();
      this.lastError = '';
      this.invalidateState(true);
      await this.store.log('game-data-update-success', this.gameData.version);
    } catch (error) {
      this.lastError = (error as Error).message;
      this.invalidateState();
      await this.store.log('game-data-update-failure', this.lastError);
      throw error;
    }
    return this.state();
  }

  async updateSettings(patch: Partial<Settings>): Promise<ReturnType<AppService['state']>> {
    const materialIds = this.unlimitedMaterials.allowed;
    const previousUnlimitedIds = this.settings.unlimitedItemIds;
    this.settings = {
      ...this.settings,
      unlimitedItemIds: (patch.unlimitedItemIds ?? this.settings.unlimitedItemIds)
        .filter(id => materialIds.has(id)),
      autoRefresh: typeof patch.autoRefresh === 'boolean' ? patch.autoRefresh : this.settings.autoRefresh,
      theme: patch.theme === 'light' || patch.theme === 'black' || patch.theme === 'system'
        ? patch.theme
        : this.settings.theme,
    };
    await this.store.writeSettings(this.settings);
    const unlimitedChanged = previousUnlimitedIds.length !== this.settings.unlimitedItemIds.length
      || previousUnlimitedIds.some((id, index) => id !== this.settings.unlimitedItemIds[index]);
    this.invalidateState(unlimitedChanged);
    return this.state();
  }

  private async sanitizeUnlimitedItems(): Promise<void> {
    const eligible = this.unlimitedMaterials.allowed;
    const filtered = this.settings.unlimitedItemIds.filter(id => eligible.has(id));
    if (filtered.length === this.settings.unlimitedItemIds.length) return;
    this.settings = { ...this.settings, unlimitedItemIds: filtered };
    await this.store.writeSettings(this.settings);
  }

  async logout(): Promise<ReturnType<AppService['state']>> {
    await this.store.clearCredentials();
    this.settings = { ...this.settings, selectedUid: undefined };
    await this.store.writeSettings(this.settings);
    this.invalidateState();
    await this.store.log('account-logout');
    return this.state();
  }

  async clearCache(): Promise<ReturnType<AppService['state']>> {
    await this.store.clearAccountCache();
    this.account = null;
    this.usingCache = false;
    this.invalidateState(true);
    await this.store.log('account-cache-cleared');
    return this.state();
  }

  materialDetail(itemId: string) {
    const material = this.materialById.get(itemId);
    if (!material) throw new Error(`未知材料：${itemId}`);
    const inventory = this.account?.inventory ?? {};
    const unlimited = new Set(this.settings.unlimitedItemIds);
    const craftable = recursiveCraftableQuantity(inventory, material.recipe, this.recipes);
    const parents = this.parentMaterials.get(itemId) ?? [];
    return {
      material,
      realQuantity: inventory[itemId] ?? 0,
      unlimited: unlimited.has(itemId),
      craftable,
      planningAvailable: (inventory[itemId] ?? 0) + craftable,
      parents,
    };
  }

  private rebuildDerivedData(): void {
    this.masteryPlanner = new MasteryPlanner(this.gameData);
    this.promotionPlanner = new PromotionPlanner(this.gameData);
    this.modulePlanner = new ModulePlanner(this.gameData);
    this.materialById = new Map(this.gameData.materials.map(material => [material.itemId, material]));
    this.recipes = this.gameData.materials.flatMap(material => material.recipe ? [material.recipe] : []);
    this.parentMaterials = new Map();
    for (const material of this.gameData.materials) {
      for (const ingredient of material.recipe?.ingredients ?? []) {
        const parents = this.parentMaterials.get(ingredient.itemId) ?? [];
        parents.push(material);
        this.parentMaterials.set(ingredient.itemId, parents);
      }
    }
    this.unlimitedMaterials = unlimitedMaterialGroups(this.gameData);
  }

  private invalidateState(plans = false): void {
    this.stateRevision += 1;
    this.cachedState = undefined;
    if (plans) this.cachedPlans = undefined;
  }
}
