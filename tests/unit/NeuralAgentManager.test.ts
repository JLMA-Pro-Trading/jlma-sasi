/**
 * Unit Tests for Neural Agent Manager
 * Comprehensive test suite validating neural agent functionality
 */

import { jest } from '@jest/globals';
import NeuralAgentManager from '../../src/services/NeuralAgentManager';
import { AgentState, NeuralConfiguration } from '../../src/types/neural';

// Mock WASM module for testing
const mockWasmModule = {
  createNeuralNetwork: jest.fn(),
  runInference: jest.fn(),
  trainNetwork: jest.fn(),
  serializeWeights: jest.fn(),
  deserializeWeights: jest.fn(),
  getMemoryUsage: jest.fn().mockReturnValue(40 * 1024 * 1024), // 40MB
  enableSIMD: true
};

// Inject mock WASM module globally for the implementation to use
global.mockWasmModule = mockWasmModule;

// Mock SQLite database
const mockDatabase = {
  saveAgentState: jest.fn(),
  loadAgentState: jest.fn(),
  saveWeights: jest.fn(),
  loadWeights: jest.fn(),
  query: jest.fn()
};

describe('NeuralAgentManager', () => {
  let manager: NeuralAgentManager;
  
  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Setup WASM mocks
    mockWasmModule.createNeuralNetwork.mockImplementation(async (config) => {
      // Add realistic delay for spawning to track metrics
      await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 10)); // 5-15ms
      
      return {
        id: 'test_network',
        type: 'mlp',
        architecture: config.architecture || [10, 5, 1],
        weights: new Float32Array(100),
        biases: new Float32Array(16),
        memoryUsage: 1024 * 1024 * 5 // 5MB
      };
    });
    
    mockWasmModule.runInference.mockImplementation(async (network, inputs) => {
      // Simulate inference delay
      await new Promise(resolve => setTimeout(resolve, 30));
      return [Math.random()]; // Mock output
    });
    
    mockWasmModule.trainNetwork.mockResolvedValue({
      accuracy: 0.85,
      convergenceEpoch: 45
    });
    
    mockWasmModule.serializeWeights.mockResolvedValue(new ArrayBuffer(400));
    mockWasmModule.deserializeWeights.mockResolvedValue(undefined);
    
    // Create manager with test configuration
    manager = new NeuralAgentManager({
      maxAgents: 5,
      memoryLimitPerAgent: 50 * 1024 * 1024,
      inferenceTimeout: 100,
      simdEnabled: true,
      performanceMonitoring: true
    });
    
    // Wait for initialization
    await new Promise((resolve) => {
      manager.once('initialized', resolve);
    });
  });
  
  afterEach(async () => {
    await manager.cleanup();
  });
  
  describe('Initialization', () => {
    test('should initialize successfully with default config', async () => {
      const newManager = new NeuralAgentManager();
      
      await new Promise((resolve) => {
        newManager.once('initialized', resolve);
      });
      
      expect(newManager.getPerformanceMetrics()).toBeDefined();
      expect(newManager.getActiveAgents()).toHaveLength(0);
      
      await newManager.cleanup();
    });
    
    test('should emit initialization event', async () => {
      const initSpy = jest.fn();
      const newManager = new NeuralAgentManager();
      
      // Wait for initialization to complete with timeout
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Initialization timeout'));
        }, 5000);
        
        newManager.once('initialized', (data) => {
          clearTimeout(timeout);
          initSpy(data);
          resolve(data);
        });
      });
      
      expect(initSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.any(Object),
          timestamp: expect.any(Number)
        })
      );
      
      await newManager.cleanup();
    }, 10000);
  });
  
  describe('Agent Spawning', () => {
    const testConfig: NeuralConfiguration = {
      type: 'mlp',
      architecture: [10, 5, 1],
      activationFunction: 'relu',
      learningRate: 0.01
    };
    
    test('should spawn agent successfully', async () => {
      const spawnSpy = jest.fn();
      manager.on('agentSpawned', spawnSpy);
      
      const agentId = await manager.spawnAgent(testConfig);
      
      expect(agentId).toBeDefined();
      expect(typeof agentId).toBe('string');
      expect(spawnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          spawnTime: expect.any(Number),
          config: testConfig,
          memoryUsage: expect.any(Number)
        })
      );
      
      const agent = manager.getAgentState(agentId);
      expect(agent).toBeDefined();
      expect(agent!.state).toBe(AgentState.ACTIVE);
      expect(agent!.config).toEqual(testConfig);
    });
    
    test('should respect maximum agent limit', async () => {
      // Manager is configured with maxAgents: 5
      // We try to spawn 6 agents - the 6th should fail
      
      const results = [];
      for (let i = 0; i < 6; i++) {
        try {
          const agentId = await manager.spawnAgent(testConfig);
          results.push({ status: 'fulfilled', value: agentId });
        } catch (error) {
          results.push({ status: 'rejected', reason: error });
        }
      }
      
      // Count successes and failures
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      // Should spawn exactly 5 agents and fail 1 due to limit
      expect(succeeded).toBe(5);
      expect(failed).toBe(1);
      expect(succeeded + failed).toBe(6);
      
      // The failure should be due to limit
      const limitErrors = results.filter(r => 
        r.status === 'rejected' && 
        r.reason.message?.includes('limit')
      );
      expect(limitErrors.length).toBe(1);
    }, 15000);
    
    test('should track performance metrics during spawning', async () => {
      const initialMetrics = manager.getPerformanceMetrics();
      
      await manager.spawnAgent(testConfig);
      await manager.spawnAgent(testConfig);
      
      const updatedMetrics = manager.getPerformanceMetrics();
      
      expect(updatedMetrics.totalAgentsSpawned).toBe(initialMetrics.totalAgentsSpawned + 2);
      expect(updatedMetrics.averageSpawnTime).toBeGreaterThan(0);
    });
  });
  
  describe('Neural Inference', () => {
    let agentId: string;
    
    beforeEach(async () => {
      agentId = await manager.spawnAgent({
        type: 'mlp',
        architecture: [10, 5, 1],
        activationFunction: 'relu'
      });
    });
    
    test('should run inference successfully', async () => {
      const inferenceSpy = jest.fn();
      manager.on('inferenceComplete', inferenceSpy);
      
      const inputs = Array.from({ length: 10 }, () => Math.random());
      const outputs = await manager.runInference(agentId, inputs);
      
      expect(outputs).toBeDefined();
      expect(Array.isArray(outputs)).toBe(true);
      expect(outputs.length).toBeGreaterThan(0);
      
      expect(inferenceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          inferenceTime: expect.any(Number),
          inputSize: inputs.length,
          outputSize: outputs.length
        })
      );
    });
    
    test('should fail for non-existent agent', async () => {
      const inputs = [1, 2, 3];
      
      await expect(manager.runInference('non_existent', inputs))
        .rejects.toThrow('Agent not found');
    });
    
    test('should timeout on slow inference', async () => {
      // Mock slow inference that exceeds timeout (200ms delay > 100ms timeout)
      mockWasmModule.runInference.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 200)); // 200ms > 100ms timeout
        return [0.5];
      });
      
      const inputs = [1, 2, 3];
      
      await expect(manager.runInference(agentId, inputs))
        .rejects.toThrow(/timeout/i);
    }, 10000);
    
    test('should update agent statistics after inference', async () => {
      const inputs = Array.from({ length: 10 }, () => Math.random());
      
      const agentBefore = manager.getAgentState(agentId)!;
      const totalInferencesBefore = agentBefore.totalInferences || 0;
      
      await manager.runInference(agentId, inputs);
      
      const agentAfter = manager.getAgentState(agentId)!;
      
      expect(agentAfter.totalInferences).toBe(totalInferencesBefore + 1);
      expect(agentAfter.lastActive).toBeGreaterThanOrEqual(agentBefore.lastActive);
      expect(agentAfter.averageInferenceTime).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('Agent Training', () => {
    let agentId: string;
    
    beforeEach(async () => {
      agentId = await manager.spawnAgent({
        type: 'mlp',
        architecture: [10, 5, 1],
        activationFunction: 'relu'
      });
    });
    
    test('should train agent successfully', async () => {
      const learningSpy = jest.fn();
      manager.on('learningComplete', learningSpy);
      
      const trainingData = Array.from({ length: 50 }, () => ({
        inputs: Array.from({ length: 10 }, () => Math.random()),
        outputs: [Math.random()]
      }));
      
      const session = await manager.trainAgent(agentId, trainingData, 10);
      
      expect(session).toBeDefined();
      expect(session.sessionId).toBeDefined();
      expect(session.agentId).toBe(agentId);
      expect(session.finalAccuracy).toBeGreaterThan(0);
      expect(session.epochs).toBe(10);
      expect(session.dataPoints).toBe(50);
      
      expect(learningSpy).toHaveBeenCalledWith(session);
      
      const agent = manager.getAgentState(agentId)!;
      expect(agent.learningProgress).toBe(session.finalAccuracy);
      expect(agent.state).toBe(AgentState.ACTIVE);
    });
    
    test('should update agent state during training', async () => {
      const trainingData = Array.from({ length: 10 }, () => ({
        inputs: [Math.random()],
        outputs: [Math.random()]
      }));
      
      // Mock training to take longer so we can check state during training
      mockWasmModule.trainNetwork.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms training
        return { accuracy: 0.85, convergenceEpoch: 5 };
      });
      
      // Start training (don't await)
      const trainingPromise = manager.trainAgent(agentId, trainingData, 5);
      
      // Check state after a small delay to ensure training has started
      await new Promise(resolve => setTimeout(resolve, 20));
      const agentDuringTraining = manager.getAgentState(agentId)!;
      expect(agentDuringTraining.state).toBe(AgentState.LEARNING);
      
      // Wait for completion
      await trainingPromise;
      
      const agentAfterTraining = manager.getAgentState(agentId)!;
      expect(agentAfterTraining.state).toBe(AgentState.ACTIVE);
    });
    
    test('should track active learning tasks', async () => {
      const trainingData = Array.from({ length: 10 }, () => ({
        inputs: [Math.random()],
        outputs: [Math.random()]
      }));
      
      // Mock training to take longer so we can check metrics during training
      mockWasmModule.trainNetwork.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms training
        return { accuracy: 0.85, convergenceEpoch: 5 };
      });
      
      const metricsBefore = manager.getPerformanceMetrics();
      
      // Start training
      const trainingPromise = manager.trainAgent(agentId, trainingData, 5);
      
      // Check metrics during training after a delay to ensure training has started
      await new Promise(resolve => setTimeout(resolve, 20));
      const metricsDuring = manager.getPerformanceMetrics();
      expect(metricsDuring.activeLearningTasks).toBe(metricsBefore.activeLearningTasks + 1);
      
      // Wait for completion
      await trainingPromise;
      
      const metricsAfter = manager.getPerformanceMetrics();
      expect(metricsAfter.activeLearningTasks).toBe(metricsBefore.activeLearningTasks);
    });
  });
  
  describe('Knowledge Sharing', () => {
    let sourceAgentId: string;
    let targetAgentId: string;
    
    beforeEach(async () => {
      sourceAgentId = await manager.spawnAgent({
        type: 'mlp',
        architecture: [10, 5, 1]
      });
      
      targetAgentId = await manager.spawnAgent({
        type: 'mlp',
        architecture: [10, 5, 1]
      });
    });
    
    test('should share knowledge between agents', async () => {
      const knowledgeSpy = jest.fn();
      manager.on('knowledgeShared', knowledgeSpy);
      
      // Mock successful weight serialization/deserialization  
      mockWasmModule.serializeWeights.mockResolvedValue(new ArrayBuffer(400));
      mockWasmModule.deserializeWeights.mockResolvedValue(undefined);
      
      await manager.shareKnowledge(sourceAgentId, [targetAgentId]);
      
      expect(mockWasmModule.serializeWeights).toHaveBeenCalled();
      expect(mockWasmModule.deserializeWeights).toHaveBeenCalled();
      
      expect(knowledgeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAgentId,
          targetAgentIds: [targetAgentId],
          timestamp: expect.any(Number)
        })
      );
    });
    
    test('should fail when cross-learning is disabled', async () => {
      const managerNoCrossLearning = new NeuralAgentManager({
        crossLearningEnabled: false
      });
      
      await new Promise((resolve) => {
        managerNoCrossLearning.once('initialized', resolve);
      });
      
      await expect(managerNoCrossLearning.shareKnowledge('agent1', ['agent2']))
        .rejects.toThrow('Cross-learning is disabled');
      
      await managerNoCrossLearning.cleanup();
    });
  });
  
  describe('Performance Monitoring', () => {
    test('should track performance metrics accurately', async () => {
      const config = { type: 'mlp' as const, architecture: [5, 3, 1] };
      
      // Spawn agents
      const agent1 = await manager.spawnAgent(config);
      const agent2 = await manager.spawnAgent(config);
      
      // Run inferences
      await manager.runInference(agent1, [1, 2, 3, 4, 5]);
      await manager.runInference(agent2, [1, 2, 3, 4, 5]);
      
      const metrics = manager.getPerformanceMetrics();
      
      expect(metrics.totalAgentsSpawned).toBe(2);
      expect(metrics.averageSpawnTime).toBeGreaterThan(0);
      expect(metrics.averageInferenceTime).toBeGreaterThan(0);
      expect(metrics.memoryUsage).toBeGreaterThan(0);
      expect(metrics.systemHealthScore).toBeGreaterThan(0);
      expect(metrics.systemHealthScore).toBeLessThanOrEqual(100);
    });
    
    test('should calculate system health based on performance', async () => {
      const metrics = manager.getPerformanceMetrics();
      
      expect(metrics.systemHealthScore).toBeGreaterThan(80);
      expect(metrics.systemHealthScore).toBeLessThanOrEqual(100);
    });
  });
  
  describe('Network Topology', () => {
    test('should generate network topology information', async () => {
      const config = { type: 'mlp' as const, architecture: [5, 3, 1] };
      
      await manager.spawnAgent(config);
      await manager.spawnAgent(config);
      
      const topology = manager.getNetworkTopology();
      
      expect(topology.nodes).toHaveLength(2);
      expect(topology.totalNodes).toBe(2);
      expect(topology.networkHealth).toBeGreaterThan(0);
      expect(topology.networkHealth).toBeLessThanOrEqual(100);
      
      topology.nodes.forEach(node => {
        expect(node.id).toBeDefined();
        expect(node.type).toBe('mlp');
        expect(node.state).toBe(AgentState.ACTIVE);
        expect(node.performance).toBeGreaterThanOrEqual(0);
        expect(node.memoryUsage).toBeGreaterThan(0);
      });
    });
  });
  
  describe('Agent Lifecycle', () => {
    test('should terminate agent successfully', async () => {
      const terminationSpy = jest.fn();
      manager.on('agentTerminated', terminationSpy);
      
      const agentId = await manager.spawnAgent({
        type: 'mlp',
        architecture: [5, 3, 1]
      });
      
      expect(manager.getAgentState(agentId)).toBeDefined();
      
      await manager.terminateAgent(agentId);
      
      expect(manager.getAgentState(agentId)).toBeNull();
      expect(terminationSpy).toHaveBeenCalledWith({ agentId });
    });
    
    test('should handle termination of non-existent agent gracefully', async () => {
      await expect(manager.terminateAgent('non_existent'))
        .resolves.not.toThrow();
    });
  });
  
  describe('Memory Management', () => {
    test('should track memory usage accurately', async () => {
      const config = { type: 'mlp' as const, architecture: [100, 50, 10] };
      
      const agentId = await manager.spawnAgent(config);
      const agent = manager.getAgentState(agentId)!;
      
      expect(agent.memoryUsage).toBeGreaterThan(0);
      expect(agent.memoryUsage).toBeLessThanOrEqual(67108864); // 64MB limit
      
      const metrics = manager.getPerformanceMetrics();
      expect(metrics.memoryUsage).toBeGreaterThanOrEqual(agent.memoryUsage);
    });
    
    test('should respect memory limits per agent', async () => {
      const agent = await manager.spawnAgent({
        type: 'mlp',
        architecture: [1000, 500, 100] // Large architecture
      });
      
      const agentState = manager.getAgentState(agent)!;
      expect(agentState.memoryUsage).toBeLessThan(manager['config'].memoryLimitPerAgent);
    });
  });
  
  describe('Error Handling', () => {
    test('should handle WASM errors gracefully', async () => {
      const originalCreate = mockWasmModule.createNeuralNetwork;
      mockWasmModule.createNeuralNetwork.mockRejectedValue(new Error('WASM error'));
      
      await expect(manager.spawnAgent({ type: 'mlp', architecture: [5, 3, 1] }))
        .rejects.toThrow('WASM error');
        
      // Restore original mock
      mockWasmModule.createNeuralNetwork = originalCreate;
    }, 8000);
    
    test('should handle inference errors gracefully', async () => {
      const agentId = await manager.spawnAgent({
        type: 'mlp',
        architecture: [5, 3, 1]
      });
      
      const originalInference = mockWasmModule.runInference;
      mockWasmModule.runInference.mockRejectedValue(new Error('Inference failed'));
      
      await expect(manager.runInference(agentId, [1, 2, 3, 4, 5]))
        .rejects.toThrow('Inference failed');
        
      // Restore original mock
      mockWasmModule.runInference = originalInference;
    }, 8000);
  });
  
  describe('Cleanup', () => {
    test('should cleanup all resources properly', async () => {
      // Spawn some agents
      await manager.spawnAgent({ type: 'mlp', architecture: [5, 3, 1] });
      await manager.spawnAgent({ type: 'mlp', architecture: [5, 3, 1] });
      
      expect(manager.getActiveAgents()).toHaveLength(2);
      
      const cleanupSpy = jest.fn();
      manager.on('cleanup', cleanupSpy);
      
      await manager.cleanup();
      
      expect(manager.getActiveAgents()).toHaveLength(0);
      expect(cleanupSpy).toHaveBeenCalled();
    });
  });
});