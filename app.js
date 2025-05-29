'use strict';

const Homey = require('homey');

module.exports = class TripleSolarApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('TripleSolar app has been initialized');
    
    // Initialize credentials store if not already done
    this._credentials = null;
    
    // Try to load credentials from storage
    try {
      this._credentials = this.homey.settings.get('credentials');
      if (this._credentials) {
        this.log('Stored credentials found');
      } else {
        this.log('No stored credentials available');
      }
    } catch (error) {
      this.error('Error loading stored credentials:', error);
    }
  }
  
  /**
   * Store credentials centrally
   */
  async storeCredentials(credentials) {
    try {
      this._credentials = credentials;
      this.homey.settings.set('credentials', credentials);
      this.log('Credentials stored centrally');
      return true;
    } catch (error) {
      this.error('Failed to store credentials:', error);
      return false;
    }
  }
  
  /**
   * Get stored credentials
   */
  getCredentials() {
    return this._credentials;
  }
  
  /**
   * Clear stored credentials
   */
  async clearCredentials() {
    try {
      this._credentials = null;
      this.homey.settings.unset('credentials');
      this.log('Credentials cleared');
      return true;
    } catch (error) {
      this.error('Failed to clear credentials:', error);
      return false;
    }
  }
};
