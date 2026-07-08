/**
 * API Configuration Example
 * 
 * Copy this file to api-config.ts and update with your actual values
 */

export const API_CONFIG = {
  // Your backend API endpoint
  endpoint: 'https://your-api.example.com/api',
  
  // Bearer token for authentication
  bearerToken: 'your-bearer-token-here',
  
  // Request timeout in milliseconds
  timeout: 30000
};

/**
 * API Endpoints Expected by the Extension:
 * 
 * POST /learning-materials
 *   - Save a single learning material
 *   - Body: SavedLearningMaterial
 *   - Returns: SavedLearningMaterial with ID
 * 
 * GET /learning-materials/:id
 *   - Retrieve a learning material by ID
 *   - Returns: SavedLearningMaterial
 * 
 * PATCH /learning-materials/:id
 *   - Update a learning material
 *   - Body: Partial<SavedLearningMaterial>
 *   - Returns: SavedLearningMaterial
 * 
 * DELETE /learning-materials/:id
 *   - Delete a learning material
 *   - Returns: { success: boolean }
 * 
 * GET /learning-materials/search?query=...&limit=20
 *   - Search learning materials
 *   - Returns: SavedLearningMaterial[]
 * 
 * POST /learning-materials/bulk
 *   - Save multiple learning materials
 *   - Body: { materials: SavedLearningMaterial[] }
 *   - Returns: SavedLearningMaterial[]
 */
