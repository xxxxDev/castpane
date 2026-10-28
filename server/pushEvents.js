// What a push notification is about, in Castpane: an event named by its own id (a
// remote session opening). services/pushStore.js is generic and asks these for what is
// the product's own; a delivery row keeps the fields given here, so they are stored
// data: the names and the values are not to be changed.
module.exports = Object.freeze({
  // The kinds of notification an account can have, each on unless it said otherwise.
  preferenceDefaults: Object.freeze({ remote: true }),
  // What one event is called in a delivery's keys (with the channel and device).
  eventKey: (event) => event.eventId,
  // The event's own fields on a delivery row, from the event and from a stored row.
  eventFields: (event) => ({ eventId: event.eventId }),
  storedEventFields: (row) => ({ eventId: row.eventId }),
  // How a row stored for this event is found.
  eventQuery: (event) => ({ eventId: event.eventId }),
  // Its category, which a preference can turn off.
  eventCategory: () => 'remote',
});
