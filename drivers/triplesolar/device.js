'use strict';

const { Device } = require('homey');
const fetch = require('node-fetch');

const TRIPLESOLAR_API = 'https://app.triplesolar.eu/graphql';
const TRIPLESOLAR_AUTH = 'https://app.triplesolar.eu/auth';

class TripleSolarDevice extends Device {

  async onInit() {
    this.log('TripleSolar device has been initialized');

    // Get the stored credentials
    this.username = this.getStoreValue('username');
    this.password = this.getStoreValue('password');
    this.accessToken = this.getStoreValue('accessToken');
    this.refreshToken = this.getStoreValue('refreshToken');
    this.interfaceId = this.getData().id;
    
    // Variable to keep track of when the boiler mode is manually set
    this.lastBoilerModeChange = 0;

    // Store the time of the last successful token refresh
    this.lastSuccessfulTokenRefresh = 0;

    // Log info about the tokens (without sensitive information)
    this.log(`Stored tokens: accessToken ${this.accessToken ? 'present' : 'missing'}, refreshToken ${this.refreshToken ? 'present' : 'missing'}, password ${this.password ? 'present' : 'missing'}`);

    // Ensure all capabilities are registered
    const requiredCapabilities = [
      'onoff.boiler',
      'measure_temperature.boiler',
      'target_temperature.boiler',
      'measure_temperature.source_return',
      'measure_temperature.source_supply',
      'measure_temperature.distribution_return',
      'measure_temperature.distribution_supply',
      'measure_temperature.compressor_discharge'
    ];

    for (const capability of requiredCapabilities) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    // Register capability listeners
    this.registerCapabilityListener('onoff.boiler', this.onCapabilityBoilerMode.bind(this));
    this.registerCapabilityListener('target_temperature.boiler', this.onCapabilityTargetTemperature.bind(this));

    try {
      // If we have a refresh token that's not too old, try to refresh
      // Otherwise, if we have a password, try direct login
      const now = Date.now();
      const refreshTokenAge = now - (this.lastSuccessfulTokenRefresh || 0);
      const refreshTokenTooOld = refreshTokenAge > 24 * 60 * 60 * 1000; // 24 hours
      
      if (this.refreshToken && !refreshTokenTooOld) {
        this.log('Refreshing accessToken on startup...');
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          this.log('AccessToken successfully refreshed');
          this.lastSuccessfulTokenRefresh = now;
        } else if (this.password) {
          this.log('AccessToken could not be refreshed, trying direct login');
          const loggedIn = await this.loginWithCredentials();
          if (loggedIn) {
            this.log('Direct login successful');
            this.lastSuccessfulTokenRefresh = now;
          } else {
            this.log('Direct login failed');
            await this.setUnavailable('Login failed, please check your credentials');
            return;
          }
        } else {
          this.log('AccessToken could not be refreshed and no password available');
          await this.setUnavailable('Authentication failed, please remove and re-add the device');
          return;
        }
      } else if (this.password) {
        // Skip refresh token attempt if too old or missing, go straight to login
        this.log('Using direct login instead of token refresh');
        const loggedIn = await this.loginWithCredentials();
        if (loggedIn) {
          this.log('Direct login successful');
          this.lastSuccessfulTokenRefresh = now;
        } else {
          this.log('Direct login failed');
          await this.setUnavailable('Login failed, please check your credentials');
          return;
        }
      } else if (!this.accessToken) {
        this.log('No tokens available, login required');
        await this.setUnavailable('Login required, please remove and re-add the device');
        return;
      }
    } catch (error) {
      this.error('Error during authentication:', error);
      // Proceed, try again later at the first poll
    }

    // Start polling for updates
    this.pollInterval = this.homey.setInterval(() => {
      this.pollTripleSolar().catch(err => {
        this.error('Poll error:', err);
      });
    }, 60 * 60 * 1000); // Poll every hour instead of every minute

    // Track consecutive errors
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;

    // Direct first poll execution
    this.pollTripleSolar().catch(err => {
      this.error('Initial poll error:', err);
    });
  }

  async onDeleted() {
    // Stop polling when device is deleted
    this.homey.clearInterval(this.pollInterval);
    this.log('Device deleted, polling stopped');
    
    // Note: We don't clear app-wide credentials here since the user
    // might want to add another device later without re-authentication
  }

  // Reset the error counter when a call succeeds
  resetErrorCounter() {
    if (this.consecutiveErrors > 0) {
      this.log(`Resetting error counter (was ${this.consecutiveErrors})`);
      this.consecutiveErrors = 0;
    }
  }
  
  // Increment error counter and handle unavailability
  async handleError() {
    this.consecutiveErrors++;
    
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.error(`${this.consecutiveErrors} consecutive errors, setting device unavailable`);
      await this.setUnavailable('Connection lost. Trying to reconnect...');
    } else {
      this.log(`Error ${this.consecutiveErrors}/${this.maxConsecutiveErrors}, device still available`);
    }
  }

  // New method for refreshing the access token
  async refreshAccessToken() {
    try {
      this.log(`Refreshing access token with refreshToken...`);
      
      const response = await fetch(`${TRIPLESOLAR_AUTH}/refresh`, {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'content-type': 'application/json',
          'origin': 'https://app.triplesolar.eu',
          'user-agent': 'Homey/TripleSolar'
        },
        body: JSON.stringify({
          refreshToken: this.refreshToken
        })
      });

      this.log(`Token refresh response status: ${response.status}`);
      
      // Read the response text and log it for debugging (without sensitive details)
      const responseText = await response.text();
      this.log(`Token refresh response received (${responseText.length} characters)`);
      
      // Check for known error messages in the response
      if (responseText.includes('incorrect token') || 
          responseText.includes('invalid token') ||
          response.status === 401) {
        this.error('Token refresh failed: invalid or expired refreshToken');
        
        // If the password is available, try to log in again
        if (this.password) {
          this.log('Password is available, trying to login again...');
          return await this.loginWithCredentials();
        }
        
        return false;
      }
      
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (jsonError) {
        this.error('Could not parse response as JSON:', jsonError);
        this.log('Response content:', responseText);
        return false;
      }

      if (result.accessToken) {
        this.log('New accessToken received');
        this.accessToken = result.accessToken;
        await this.setStoreValue('accessToken', result.accessToken);
        
        // If there is a new refreshToken, save it as well
        if (result.refreshToken) {
          this.log('New refreshToken received');
          this.refreshToken = result.refreshToken;
          await this.setStoreValue('refreshToken', result.refreshToken);
        }
        
        // Update the last successful token refresh timestamp
        this.lastSuccessfulTokenRefresh = Date.now();
        
        // Update app-wide credentials with new tokens
        await this.updateGlobalTokens();
        
        return true;
      }

      this.error('No accessToken in response');
      this.log('Response content:', responseText);
      return false;
    } catch (error) {
      this.error('Error when logging in again:', error);
      return false;
    }
  }

  // Method to log in completely again with stored login credentials
  async loginWithCredentials() {
    try {
      if (!this.username || !this.password) {
        this.error('Cannot login, username or password is missing');
        return false;
      }
      
      // Mask the email address for privacy in logs
      const maskedUsername = this.username.replace(/(.{2})(.*)(@.*)/, '$1***$3');
      this.log(`Logging in again with username: ${maskedUsername}`);
      const response = await fetch('https://app.triplesolar.eu/auth/login', {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'content-type': 'application/json',
          'origin': 'https://app.triplesolar.eu',
          'user-agent': 'Homey/TripleSolar'
        },
        body: JSON.stringify({
          email: this.username,
          password: this.password
        })
      });

      this.log('Login response status:', response.status);
      
      // Read the response text and log it for debugging (without sensitive details)
      const responseText = await response.text();
      this.log(`Login response received (${responseText.length} characters)`);
      
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (jsonError) {
        this.error('Could not parse login response as JSON:', jsonError);
        return false;
      }
      
      // Check and save tokens
      if (result.accessToken) {
        this.log('New accessToken received after renewed login');
        this.accessToken = result.accessToken;
        await this.setStoreValue('accessToken', result.accessToken);
      } else {
        this.error('No accessToken in login response');
        return false;
      }
      
      if (result.refreshToken) {
        this.log('New refreshToken received after renewed login');
        this.refreshToken = result.refreshToken;
        await this.setStoreValue('refreshToken', result.refreshToken);
      } else {
        this.error('No refreshToken in login response');
        return false;
      }

      // Update the last successful token refresh timestamp
      this.lastSuccessfulTokenRefresh = Date.now();
      
      // Update app-wide credentials with new tokens
      await this.updateGlobalTokens();
      
      this.log('Re-login successful');
      return true;
    } catch (error) {
      this.error('Error while logging in again:', error);
      return false;
    }
  }

  // Helper method for performing API calls with automatic token refreshing
  async makeApiCall(operation, variables, query) {
    try {
      const headers = {
        'accept': '*/*',
        'content-type': 'application/json',
        'authorization': `Bearer ${this.accessToken}`,
        'origin': 'https://app.triplesolar.eu',
        'user-agent': 'Homey/TripleSolar'
      };

      // Add timestamp to track API call duration
      const startTime = Date.now();
      
      const response = await fetch(TRIPLESOLAR_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationName: operation,
          variables,
          query
        })
      });

      // Calculate API call duration
      const duration = Date.now() - startTime;

      // If we get a 401, try to refresh the token
      if (response.status === 401) {
        this.log(`Received 401 unauthorized for ${operation}, attempting to refresh token`);
        
        // If we have a refreshToken, try to refresh
        if (this.refreshToken) {
          const refreshed = await this.refreshAccessToken();
          if (refreshed) {
            // Try the call again with the new token
            this.log('Token refreshed successfully, retrying API call');
            headers.authorization = `Bearer ${this.accessToken}`;
            const retryResponse = await fetch(TRIPLESOLAR_API, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                operationName: operation,
                variables,
                query
              })
            });
            
            // Read the response text and log it for debugging
            const retryResponseText = await retryResponse.text();
            this.log(`Retry API response status: ${retryResponse.status}, Content: ${retryResponseText.substring(0, 200)}...`);
            
            try {
              // Try to parse the response text as JSON
              return JSON.parse(retryResponseText);
            } catch (jsonError) {
              this.error('Failed to parse retry response as JSON:', jsonError);
              throw new Error(`Invalid JSON in API response: ${retryResponseText.substring(0, 100)}`);
            }
          } else {
            // If token refreshing fails but we have a password, try to log in again
            if (this.password) {
              this.log('Token refresh failed, trying to login again with password...');
              const loggedIn = await this.loginWithCredentials();
              if (loggedIn) {
                // Try the call again with the new tokens after logging in
                this.log('Login successful, trying again with new tokens');
                headers.authorization = `Bearer ${this.accessToken}`;
                const retryLoginResponse = await fetch(TRIPLESOLAR_API, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    operationName: operation,
                    variables,
                    query
                  })
                });
                
                // Read the response text and log it for debugging
                const retryLoginResponseText = await retryLoginResponse.text();
                this.log(`Retry API after login response status: ${retryLoginResponse.status}, Content: ${retryLoginResponseText.substring(0, 200)}...`);
                
                try {
                  // Try to parse the response text as JSON
                  return JSON.parse(retryLoginResponseText);
                } catch (jsonError) {
                  this.error('Failed to parse retry after login response as JSON:', jsonError);
                  throw new Error(`Invalid JSON in API response: ${retryLoginResponseText.substring(0, 100)}`);
                }
              } else {
                // If logging in fails, make the device unavailable
                this.error('Login failed, setting device as unavailable');
                await this.setUnavailable('Authentication error. Check your login credentials and restart Homey or remove and re-add the device.');
                throw new Error('Authentication failed, could not login again');
              }
            } else {
              // If token refreshing fails and no password is available, make the device unavailable
              this.error('Token refresh failed, setting device as unavailable');
              await this.setUnavailable('Authentication error. Please remove and re-add the device.');
              throw new Error('Authentication failed, token could not be renewed');
            }
          }
        } else {
          // No refreshToken available
          this.error('No refreshToken available, setting device as unavailable');
          await this.setUnavailable('Login credentials expired. Please remove and re-add the device.');
          throw new Error('Authentication failed, no refreshToken available');
        }
      }

      // Read the response text and log it for debugging
      const responseText = await response.text();
      // Log API call details with duration
      this.log(`API ${operation} completed in ${duration}ms with status: ${response.status}`);
      
      // Only log the first part of the content in verbose mode, or when status is not 200
      if (response.status !== 200) {
        this.log(`API response content: ${responseText.substring(0, 200)}...`);
      }
      
      try {
        // Try to parse the response text as JSON
        return JSON.parse(responseText);
      } catch (jsonError) {
        this.error('Failed to parse response as JSON:', jsonError);
        throw new Error(`Invalid JSON in API response: ${responseText.substring(0, 100)}`);
      }
    } catch (error) {
      this.error('API call failed:', error);
      throw error;
    }
  }

  async pollTripleSolar() {
    try {
      // Get extended heat pump status with the new GraphQL query
      const result = await this.makeApiCall(
        'ReadHeatPumpSettings',
        { interfaceId: this.interfaceId },
        `query ReadHeatPumpSettings($interfaceId: String!) {
          interface(interfaceId: $interfaceId) {
            id
            firmwareVersion {
              version
              timestamp
              __typename
            }
            controller {
              backupHeater
              chSetpMaxTemp
              manualCoolingMode
              __typename
            }
            name
            openThermBoilerConnected
            pvtHeatPump {
              id
              firmwareVersion
              dhwMode
              roomTemperatureControl
              roomControlType
              shBackupEnable
              sinkMinShTemp
              sinkMaxShTemp
              flushingMode
              dhwAutoTemp
              shRoomSetpTemp
              shRoomHysteresisTemp
              scRoomSetpTemp
              scRoomHysteresisTemp
              sinkCoolingPauseThresholdTemp
              dhwState
              spaceHeatingCoolingState
              shBoostEnabled
              dhwBoostEnabled
              boostSourceTemp
              errors
              dhwBoilerTemp
              compressorOn
              electricElementOn
              coolingValveEnabled
              pumpRelayOn
              sourcePumpPerc
              sinkPumpPerc
              sourceInTemp
              sourceOutTemp
              sinkInTemp
              sinkOutTemp
              compressorDischarge
              __typename
            }
            openTherm {
              roomTemp
              roomSetpTemp
              __typename
            }
            status {
              signalStrength
              operatorName
              __typename
            }
            __typename
          }
        }`
      );
      
      if (result.data && result.data.interface) {
        const interfaceObj = result.data.interface;
        const heatPump = interfaceObj.pvtHeatPump;
        const openTherm = interfaceObj.openTherm;
        
        // Log the important values
        this.log('Heat pump status:', {
          name: interfaceObj.name,
          dhwBoilerTemp: heatPump.dhwBoilerTemp,
          dhwMode: heatPump.dhwMode,
          dhwState: heatPump.dhwState,
          spaceHeatingCoolingState: heatPump.spaceHeatingCoolingState,
          roomTemp: openTherm?.roomTemp || null,
          roomSetpTemp: openTherm?.roomSetpTemp || null
        });
        
        // Update capabilities
        await this.setAvailable();
        
        // Update all temperature measurements
        await this.setCapabilityValue('measure_temperature.boiler', heatPump.dhwBoilerTemp);
        await this.setCapabilityValue('measure_temperature.source_return', heatPump.sourceInTemp);
        await this.setCapabilityValue('measure_temperature.source_supply', heatPump.sourceOutTemp);
        await this.setCapabilityValue('measure_temperature.distribution_return', heatPump.sinkInTemp);
        await this.setCapabilityValue('measure_temperature.distribution_supply', heatPump.sinkOutTemp);
        await this.setCapabilityValue('measure_temperature.compressor_discharge', heatPump.compressorDischarge);

        // Energy consumption (if available)
        if (heatPump.sourcePumpPerc !== undefined) {
          // Simplified power estimation, can be adjusted with better calculation
          const estimatedPower = heatPump.compressorOn ? 500 : 0; // Simplified estimation
          await this.setCapabilityValue('measure_power', estimatedPower);
        }

        // Update boiler mode based on dhwMode instead of dhwState
        // Boiler is active if dhwMode is 'AUTO'
        const boilerIsOn = heatPump.dhwMode === 'AUTO';
        this.log(`Boiler mode: ${heatPump.dhwMode}, state: ${heatPump.dhwState}, interpreting as ${boilerIsOn ? 'ON' : 'OFF'}`);
        
        const currentBoilerMode = this.getCapabilityValue('onoff.boiler');
        this.log(`Current boiler mode: ${currentBoilerMode}, new boiler mode: ${boilerIsOn}`);
        
        // Only update if there hasn't been a recent manual change (within 5 minutes)
        const timeSinceLastChange = Date.now() - (this.lastBoilerModeChange || 0);
        const recentlyChanged = timeSinceLastChange < 5 * 60 * 1000; // 5 minutes
        
        if (currentBoilerMode !== boilerIsOn && !recentlyChanged) {
          this.log(`Boiler mode has changed from ${currentBoilerMode} to ${boilerIsOn} (no recent manual change)`);
          await this.setCapabilityValue('onoff.boiler', boilerIsOn);
          
          // Trigger the flow
          const tokens = {
            boiler_mode: boilerIsOn
          };
          this.log(`Triggering flow for boiler mode change, mode=${boilerIsOn}`);
          this.driver.triggerBoilerModeChanged(this, tokens);
        } else if (currentBoilerMode !== boilerIsOn && recentlyChanged) {
          this.log(`Boiler status differs from setting, but not updating due to recent manual change (${Math.round(timeSinceLastChange / 1000)}s ago)`);
        }
      }
      
      // Reset error counter on successful poll
      this.resetErrorCounter();
      
      // If the device was unavailable, set it available again
      if (!this.getAvailable()) {
        this.log('Device is back online, setting available');
        await this.setAvailable();
      }
      
    } catch (error) {
      this.error('Error polling TripleSolar:', error);
      // Handle consecutive errors
      await this.handleError();
    }
  }

  async onCapabilityTargetTemperature(value) {
    try {
      const result = await this.makeApiCall(
        'SetTargetTemperature',
        {
          interfaceId: this.interfaceId,
          temperature: value
        },
        `mutation SetTargetTemperature($interfaceId: ID!, $temperature: Float!) {
          setTargetTemperature(interfaceId: $interfaceId, temperature: $temperature) {
            success
            message
            __typename
          }
        }`
      );
      
      if (result.data && result.data.setTargetTemperature && result.data.setTargetTemperature.success) {
        await this.setCapabilityValue('target_temperature.boiler', value);
      } else {
        throw new Error(result.data?.setTargetTemperature?.message || 'Failed to set temperature');
      }
    } catch (error) {
      this.error('Failed to set target temperature:', error);
      throw new Error('Failed to set target temperature');
    }
  }

  async onCapabilityBoilerMode(value) {
    try {
      // Log the action for debugging
      this.log(`Setting boiler mode to ${value ? 'AUTO' : 'OFF'}`);
      
      try {
        // First method - standard GraphQL mutation
        const result = await this.makeApiCall(
          'UpdatePvtHeatPumpSettings',
          {
            interfaceIds: [this.interfaceId],
            pvtHeatPumpdata: {
              dhwMode: value ? 'AUTO' : 'OFF'
            }
          },
          `mutation UpdatePvtHeatPumpSettings($interfaceIds: [String!]!, $pvtHeatPumpdata: PvtHeatPumpInput!) {
            updatePvtHeatPump(data: $pvtHeatPumpdata, interfaceIds: $interfaceIds)
          }`
        );
        
        if (result.data && (result.data.updatePvtHeatPump === true || result.data.updatePvtHeatPump === null)) {
          this.log('Boiler mode successfully updated to', value ? 'AUTO' : 'OFF');
          await this.setCapabilityValue('onoff.boiler', value);
          
          // Save the timestamp of this change
          this.lastBoilerModeChange = Date.now();
          
          // Trigger the flow
          const tokens = {
            boiler_mode: value
          };
          this.driver.triggerBoilerModeChanged(this, tokens);
          
          return true;
        }
        this.log('First method failed, trying alternative method...');
        // If we get here, the first method didn't succeed
      } catch (firstMethodError) {
        this.error('First method failed:', firstMethodError);
        this.log('Trying alternative method...');
      }
      
      // Alternative method - simplified mutation
      try {
        const altResult = await this.makeApiCall(
          'SetBoilerMode',
          {
            interfaceId: this.interfaceId,
            mode: value ? 'AUTO' : 'OFF'
          },
          `mutation SetBoilerMode($interfaceId: ID!, $mode: String!) {
            setDhwMode(interfaceId: $interfaceId, mode: $mode) {
              success
              message
              __typename
            }
          }`
        );
        
        if (altResult.data && altResult.data.setDhwMode && altResult.data.setDhwMode.success) {
          this.log('Boiler mode successfully updated using alternative method to', value ? 'AUTO' : 'OFF');
          await this.setCapabilityValue('onoff.boiler', value);
          
          // Save the timestamp of this change
          this.lastBoilerModeChange = Date.now();
          
          // Trigger the flow
          const tokens = {
            boiler_mode: value
          };
          this.driver.triggerBoilerModeChanged(this, tokens);
          
          return true;
        } else {
          this.error('Alternative method failed:', altResult);
          throw new Error(altResult.data?.setDhwMode?.message || 'Failed to set boiler mode');
        }
      } catch (error) {
        this.error('All methods to set boiler mode failed:', error);
        throw new Error('Failed to set boiler mode');
      }
    } catch (error) {
      this.error('Failed to set boiler mode:', error);
      throw new Error('Failed to set boiler mode');
    }
  }

  // updating device-level tokens, also update app-wide credentials
  async updateGlobalTokens() {
    // Only update if both tokens are available
    if (this.accessToken && this.refreshToken) {
      const appCredentials = this.homey.app.getCredentials() || {};
      
      // Update with new token values
      appCredentials.accessToken = this.accessToken;
      appCredentials.refreshToken = this.refreshToken;
      appCredentials.timestamp = Date.now();
      
      // Only update username/password if not already present
      if (!appCredentials.username && this.username) {
        appCredentials.username = this.username;
      }
      
      if (!appCredentials.password && this.password) {
        appCredentials.password = this.password;
      }
      
      // Store updated credentials app-wide
      await this.homey.app.storeCredentials(appCredentials);
    }
  }
}

module.exports = TripleSolarDevice; 