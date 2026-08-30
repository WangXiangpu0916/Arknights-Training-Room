import { AccountSnapshot, GameData, Settings } from './domain/types';
import { LocalStore } from './data/local-store';
import { ToolboxGameDataProvider } from './data/game-data-provider';
import { SklandClient } from './data/skland-client';
import { MasteryPlanner } from './engine/mastery';
import { PromotionPlanner } from './engine/promotion';
import { ModulePlanner } from './engine/module';
import { directCraftableQuantity } from './engine/crafting';
import { unlimitedMaterialGroups } from './domain/mastery-materials';

export class AppService {
  private gameData!: GameData;
  private account: AccountSnapshot | null = null;
  private settings!: Settings;
  private usingCache = true;
  private lastError = '';

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
    await this.sanitizeUnlimitedItems();
  }

  async state() {
    const loggedIn = Boolean(await this.store.readCredentials());
    const planner = new MasteryPlanner(this.gameData);
    const promotionPlanner = new PromotionPlanner(this.gameData);
    const modulePlanner = new ModulePlanner(this.gameData);
    const unlimitedMaterials = unlimitedMaterialGroups(this.gameData);
    const single = this.account
      ? planner.singleStage(this.account.operators, this.account.inventory, this.settings.unlimitedItemIds)
      : [];
    const continuous = this.account
      ? planner.continuous(
          this.account.operators,
          this.account.inventory,
          this.settings.unlimitedItemIds,
          this.settings.continuousSort,
        )
      : [];
    const singleReal = this.account
      ? planner.singleStage(this.account.operators, this.account.inventory, [])
      : [];
    const continuousReal = this.account
      ? planner.continuous(this.account.operators, this.account.inventory, [], this.settings.continuousSort)
      : [];
    return {
      loggedIn,
      account: this.account,
      gameData: this.gameData,
      settings: this.settings,
      unlimitedEligibleItemIds: [...unlimitedMaterials.blue],
      skillSummaryItemIds: [...unlimitedMaterials.skillSummaries],
      single,
      continuous,
      singleReal,
      continuousReal,
      promotions: this.account
        ? promotionPlanner.candidates(this.account.operators, this.account.inventory)
        : [],
      modules: this.account
        ? modulePlanner.candidates(this.account.operators, this.account.inventory)
        : [],
      usingCache: Boolean(this.account && this.usingCache),
      lastError: this.lastError,
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
      await this.store.log('account-refresh-success', `uid=${selectedUid}`);
    } catch (error) {
      this.lastError = (error as Error).message;
      await this.store.log('account-refresh-failure', this.lastError);
      throw error;
    }
    return this.state();
  }

  async updateGameData(): Promise<ReturnType<AppService['state']>> {
    try {
      this.gameData = await this.gameProvider.update();
      await this.sanitizeUnlimitedItems();
      this.lastError = '';
      await this.store.log('game-data-update-success', this.gameData.version);
    } catch (error) {
      this.lastError = (error as Error).message;
      await this.store.log('game-data-update-failure', this.lastError);
      throw error;
    }
    return this.state();
  }

  async updateSettings(patch: Partial<Settings>): Promise<ReturnType<AppService['state']>> {
    const materialIds = unlimitedMaterialGroups(this.gameData).allowed;
    this.settings = {
      ...this.settings,
      ...patch,
      unlimitedItemIds: (patch.unlimitedItemIds ?? this.settings.unlimitedItemIds)
        .filter(id => materialIds.has(id)),
      continuousSort: patch.continuousSort === 'reverse' ? 'reverse' :
        patch.continuousSort === 'forward' ? 'forward' : this.settings.continuousSort,
      theme: patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system'
        ? patch.theme
        : this.settings.theme,
    };
    await this.store.writeSettings(this.settings);
    return this.state();
  }

  private async sanitizeUnlimitedItems(): Promise<void> {
    const eligible = unlimitedMaterialGroups(this.gameData).allowed;
    const filtered = this.settings.unlimitedItemIds.filter(id => eligible.has(id));
    if (filtered.length === this.settings.unlimitedItemIds.length) return;
    this.settings = { ...this.settings, unlimitedItemIds: filtered };
    await this.store.writeSettings(this.settings);
  }

  async logout(): Promise<ReturnType<AppService['state']>> {
    await this.store.clearCredentials();
    this.settings = { ...this.settings, selectedUid: undefined };
    await this.store.writeSettings(this.settings);
    await this.store.log('account-logout');
    return this.state();
  }

  async clearCache(): Promise<ReturnType<AppService['state']>> {
    await this.store.clearAccountCache();
    this.account = null;
    this.usingCache = false;
    await this.store.log('account-cache-cleared');
    return this.state();
  }

  materialDetail(itemId: string) {
    const material = this.gameData.materials.find(x => x.itemId === itemId);
    if (!material) throw new Error(`未知材料：${itemId}`);
    const inventory = this.account?.inventory ?? {};
    const unlimited = new Set(this.settings.unlimitedItemIds);
    const craftable = directCraftableQuantity(inventory, material.recipe);
    const parents = this.gameData.materials.filter(x =>
      x.recipe?.ingredients.some(ingredient => ingredient.itemId === itemId),
    );
    return {
      material,
      realQuantity: inventory[itemId] ?? 0,
      unlimited: unlimited.has(itemId),
      craftable,
      planningAvailable: (inventory[itemId] ?? 0) + craftable,
      parents,
    };
  }
}
