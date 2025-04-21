# Orderdesk Shipping API

This project is an API designed to process shipping orders for multiple stores using [Express](https://expressjs.com). It securely manages store-specific API keys through environment variables and integrates with the [OrderDesk API](https://orderdesk.com/) to fetch order details and post shipment information.

## Features

- Processes shipping orders for multiple stores.
- Fetches order details from the OrderDesk API.
- Posts shipment details to the OrderDesk API.
- Validates request payloads for correctness.
- Handles errors gracefully with middleware.
- Processes one order at a time sequentially.

## Project Structure

- **index.js**:  
  The main entry point of the application. It initializes the Express server, sets up middleware, and defines the API routes.

- **.env**:  
  Stores environment variables such as API keys for each store (e.g., `STORE_21633`, `STORE_40348`, etc.) and the server port.

- **package.json**:  
  Defines project metadata and dependencies, including:
  - `express`: Web framework for building the API.
  - `node-fetch`: Used for making HTTP requests to the OrderDesk API.
  - `dotenv`: Loads environment variables from a `.env` file.
  - `body-parser`: Middleware for parsing JSON request bodies.

## API Endpoints

### POST `/`
Processes shipping orders for one or more stores.

#### Request Body
The request body should be a JSON object or an array of objects with the following fields:
- `tracking_number` (string): The tracking number for the shipment.
- `shipment_date` (string): The shipment date in ISO 8601 format (e.g., `YYYY-MM-DD`).
- `order_number` (string): The order number, which includes the store ID as a prefix (e.g., `21633-001`).

#### Example Request
```json
{
  "tracking_number": "123456789",
  "shipment_date": "2025-04-21",
  "order_number": "21633-001"
}
```

#### Example Response
- **Success (200)**:
  ```json
  {
    "message": "Orders processed",
    "results": [
      {
        "order": {
          "tracking_number": "123456789",
          "shipment_date": "2025-04-21",
          "order_number": "21633-001"
        },
        "getResponse": { /* Order details fetched from OrderDesk */ },
        "postResponse": { /* Shipment details posted to OrderDesk */ }
      }
    ]
  }
  ```
- **Error (400)**:
  ```json
  {
    "message": "Not OKAY",
    "results": [
      {
        "order": {
          "tracking_number": "123456789",
          "shipment_date": "2025-04-21",
          "order_number": "21633-001"
        },
        "error": "Invalid store ID"
      }
    ]
  }
  ```

## Setup & Installation

1. **Clone the Repository:**  
   ```sh
   git clone <repository-url>
   cd Orderdesk
   ```

2. **Install Dependencies:**  
   Run the following command to install dependencies:
   ```sh
   npm install
   ```

3. **Set Up Environment Variables:**  
   Create a `.env` file in the root directory and add the following variables:
   ```env
   PORT=3000
   STORE_21633=<API_KEY_FOR_STORE_21633>
   STORE_40348=<API_KEY_FOR_STORE_40348>
   # Add API keys for other stores as needed
   ```

4. **Start the Server:**  
   Run the following command to start the server:
   ```sh
   npm start
   ```
   The server will run on `http://localhost:3000` by default.

## Dependencies

- [Express](https://expressjs.com): Web framework for building the API.
- [node-fetch](https://www.npmjs.com/package/node-fetch): For making HTTP requests.
- [dotenv](https://www.npmjs.com/package/dotenv): For managing environment variables.
- [body-parser](https://www.npmjs.com/package/body-parser): Middleware for parsing JSON request bodies.

## Notes

- Ensure that all required environment variables are set in the `.env` file before starting the server.
- The API processes one order at a time sequentially. If an error occurs while processing an order, subsequent orders will not be processed.

## License

This project is licensed under the [MIT License](LICENSE).