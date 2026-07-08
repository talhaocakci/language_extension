import type { SavedLearningMaterial, APIConfig } from '../types/api';
import { StorageManager } from '../background/storage-manager';

export class APIClient {
  private static config: APIConfig | null = null;

  static async initialize(): Promise<void> {
    const preferences = await StorageManager.getPreferences();
    
    this.config = {
      endpoint: preferences.apiEndpoint,
      bearerToken: preferences.apiToken,
      timeout: 30000
    };
  }

  static isConfigured(): boolean {
    return !!(this.config?.endpoint && this.config?.bearerToken);
  }

  static async saveLearningMaterial(material: SavedLearningMaterial): Promise<SavedLearningMaterial> {
    if (!this.config || !this.config.endpoint) {
      throw new Error('API not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config!.timeout);

    try {
      const response = await fetch(`${this.config.endpoint}/learning-materials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.bearerToken}`
        },
        body: JSON.stringify(material),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || 
          `API Error: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      return data as SavedLearningMaterial;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof TypeError) {
        throw new Error('Network error - check API endpoint');
      }
      throw error;
    }
  }

  static async getLearningMaterial(id: string): Promise<SavedLearningMaterial> {
    if (!this.config || !this.config.endpoint) {
      throw new Error('API not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config!.timeout);

    try {
      const response = await fetch(
        `${this.config.endpoint}/learning-materials/${id}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.config.bearerToken}`
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  static async deleteLearningMaterial(id: string): Promise<void> {
    if (!this.config || !this.config.endpoint) {
      throw new Error('API not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config!.timeout);

    try {
      const response = await fetch(
        `${this.config.endpoint}/learning-materials/${id}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${this.config.bearerToken}`
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  static async searchMaterials(query: string, limit: number = 20): Promise<SavedLearningMaterial[]> {
    if (!this.config || !this.config.endpoint) {
      throw new Error('API not configured');
    }

    const params = new URLSearchParams({ query, limit: limit.toString() });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config!.timeout);

    try {
      const response = await fetch(
        `${this.config.endpoint}/learning-materials/search?${params}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.config.bearerToken}`
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  static async updateLearningMaterial(
    id: string,
    updates: Partial<SavedLearningMaterial>
  ): Promise<SavedLearningMaterial> {
    if (!this.config || !this.config.endpoint) {
      throw new Error('API not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config!.timeout);

    try {
      const response = await fetch(
        `${this.config.endpoint}/learning-materials/${id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.bearerToken}`
          },
          body: JSON.stringify(updates),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  static async bulkSaveMaterials(materials: SavedLearningMaterial[]): Promise<SavedLearningMaterial[]> {
    if (!this.config || !this.config.endpoint) {
      throw new Error('API not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config!.timeout * 2);

    try {
      const response = await fetch(
        `${this.config.endpoint}/learning-materials/bulk`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.bearerToken}`
          },
          body: JSON.stringify({ materials }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}
