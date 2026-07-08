import type { UserPreferences, StorageData } from '../types/common';
import type { SavedLearningMaterial } from '../types/api';

export class StorageManager {
  private static readonly STORAGE_KEYS = {
    PREFERENCES: 'preferences',
    SAVED_MATERIALS: 'savedMaterials',
    RECENT_VIDEOS: 'recentVideos',
    CACHE: 'cache'
  };

  static async getPreferences(): Promise<UserPreferences> {
    const result = await chrome.storage.sync.get(this.STORAGE_KEYS.PREFERENCES);
    return result[this.STORAGE_KEYS.PREFERENCES] || this.getDefaultPreferences();
  }

  static async setPreferences(preferences: Partial<UserPreferences>): Promise<void> {
    const current = await this.getPreferences();
    const updated = { ...current, ...preferences };
    await chrome.storage.sync.set({
      [this.STORAGE_KEYS.PREFERENCES]: updated
    });
  }

  static async saveLearningMaterial(material: SavedLearningMaterial): Promise<void> {
    const materials = await this.getSavedMaterials();
    materials[material.id] = material;
    await chrome.storage.sync.set({
      [this.STORAGE_KEYS.SAVED_MATERIALS]: materials
    });
    
    await this.saveMaterialToLocal(material);
  }

  static async getSavedMaterials(): Promise<Record<string, SavedLearningMaterial>> {
    const result = await chrome.storage.sync.get(this.STORAGE_KEYS.SAVED_MATERIALS);
    return result[this.STORAGE_KEYS.SAVED_MATERIALS] || {};
  }

  static async getSavedMaterial(id: string): Promise<SavedLearningMaterial | null> {
    const materials = await this.getSavedMaterials();
    return materials[id] || null;
  }

  static async deleteSavedMaterial(id: string): Promise<void> {
    const materials = await this.getSavedMaterials();
    delete materials[id];
    await chrome.storage.sync.set({
      [this.STORAGE_KEYS.SAVED_MATERIALS]: materials
    });
    
    localStorage.removeItem(`material_${id}`);
  }

  static async addRecentVideo(videoId: string, metadata: any): Promise<void> {
    const videos = await this.getRecentVideos();
    videos[videoId] = {
      ...metadata,
      lastViewed: new Date().toISOString()
    };
    
    await chrome.storage.local.set({
      [this.STORAGE_KEYS.RECENT_VIDEOS]: videos
    });
  }

  static async getRecentVideos(): Promise<Record<string, any>> {
    const result = await chrome.storage.local.get(this.STORAGE_KEYS.RECENT_VIDEOS);
    return result[this.STORAGE_KEYS.RECENT_VIDEOS] || {};
  }

  static setLocalCache(key: string, data: any, ttlMs: number = 3600000): void {
    const cacheEntry = {
      data,
      timestamp: Date.now(),
      ttl: ttlMs
    };
    localStorage.setItem(`cache_${key}`, JSON.stringify(cacheEntry));
  }

  static getLocalCache(key: string): any | null {
    const cached = localStorage.getItem(`cache_${key}`);
    if (!cached) return null;

    try {
      const { data, timestamp, ttl } = JSON.parse(cached);
      const isExpired = Date.now() - timestamp > ttl;
      
      if (isExpired) {
        localStorage.removeItem(`cache_${key}`);
        return null;
      }

      return data;
    } catch {
      return null;
    }
  }

  static clearLocalCache(key: string): void {
    localStorage.removeItem(`cache_${key}`);
  }

  static clearAllLocalCache(): void {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith('cache_')) {
        localStorage.removeItem(key);
      }
    });
  }

  private static saveMaterialToLocal(material: SavedLearningMaterial): void {
    const safeData = {
      ...material,
      audioClipUrl: undefined,
      grammarAnalysis: {
        ...material.grammarAnalysis,
        phrases: material.grammarAnalysis.phrases.map(p => ({
          ...p,
          color: undefined
        }))
      }
    };
    
    localStorage.setItem(`material_${material.id}`, JSON.stringify(safeData));
  }

  private static getDefaultPreferences(): UserPreferences {
    return {
      apiEndpoint: '',
      apiToken: '',
      llmEndpoint: '',
      llmApiKey: '',
      llmModel: 'gpt-4',
      theme: 'light',
      language: 'en',
      autoSaveEnabled: false
    };
  }
}
